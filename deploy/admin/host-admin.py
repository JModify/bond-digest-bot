#!/usr/bin/env python3
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

STATE = Path("/var/lib/bond-sdc-admin")
KEYS = ("ACME_EMAIL", "DIGEST_GROUP_ADDRESS", "SDC_ADMIN_EC2_INSTANCE_ID")
EMAIL = re.compile(r"[a-z0-9_.+%\-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+", re.I | re.ASCII)
INSTANCE = re.compile(r"i-(?:[a-f0-9]{8}|[a-f0-9]{17})")
BEGIN = b"# BEGIN SERVICE DESK CENTRAL ADMIN SETTINGS\n"
END = b"# END SERVICE DESK CENTRAL ADMIN SETTINGS\n"
BLOCK = re.compile(rb"(?m)^" + re.escape(BEGIN) + b"".join(key.encode() + rb"='[^'\r\n]*'\n" for key in KEYS) + re.escape(END) + rb"\Z")


class CheckoutError(ValueError):
    """A checkout failure with a message safe to display in the admin panel."""


def write_json(path, data):
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as out:
        staging = Path(out.name)
        try:
            json.dump(data, out)
            os.fchmod(out.fileno(), 0o644)
            out.flush()
            os.fsync(out.fileno())
            os.replace(staging, path)
        finally:
            staging.unlink(missing_ok=True)


def status(state, detail):
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    write_json(STATE / "status" / "update.json", {"state": state, "detail": detail, "updatedAt": now})


def read_regular(path, limit, owner=None):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as reader:
        info = os.fstat(reader.fileno())
        if not stat.S_ISREG(info.st_mode) or (owner is not None and info.st_uid != owner) or info.st_size > limit:
            raise ValueError("Invalid input file")
        data = reader.read(limit + 1)
        if len(data) > limit:
            raise ValueError("Input exceeds the size limit")
        return data, info


def settings_valid(values, automatic):
    if not isinstance(values, dict) or values.keys() != set(KEYS) or not all(isinstance(value, str) for value in values.values()):
        return False
    certificate, group, instance = (values[key] for key in KEYS)
    return (len(certificate) <= 254 and bool(EMAIL.fullmatch(certificate))
            and ((not group and not automatic) or (len(group) <= 254 and bool(EMAIL.fullmatch(group))))
            and (not instance or bool(INSTANCE.fullmatch(instance))))


def dotenv_candidate(existing, values):
    base = BLOCK.sub(b"", existing)
    if base and not base.endswith(b"\n"):
        base += b"\n"
    overrides = b"".join(f"{key}='{values[key]}'\n".encode("ascii") for key in KEYS)
    return base + BEGIN + overrides + END


class Deployment:
    def __init__(self):
        self.root = Path(os.environ["BOND_SDC_DEPLOY_ROOT"])
        self.user = os.environ["BOND_SDC_DEPLOY_USER"]
        self.central = self.root / "bond-service-desk-central"
        self.bot = self.root / "bond-digest-bot"
        self.dotenv = self.bot / ".env"
        self.automatic = os.environ["BOND_SDC_COMPOSE_MODE"] == "automatic"
        self.environment = {key: value for key, value in os.environ.items() if key not in KEYS}

    def projection(self, dotenv):
        service = {"image": "scratch", "environment": {key: "${" + key + ":-}" for key in KEYS}}
        document = json.dumps({"services": {"settings": service}})
        command = ["docker", "compose", "--env-file", str(dotenv), "-f", "-", "config", "--format", "json"]
        result = subprocess.run(command, cwd=self.bot, env=self.environment, input=document,
                                capture_output=True, text=True, timeout=30, check=True)
        values = json.loads(result.stdout)["services"]["settings"]["environment"]
        return {key: values.get(key) or "" for key in KEYS}

    def snapshot(self):
        values = self.projection(self.dotenv)
        for key, pattern in zip(KEYS, (EMAIL, EMAIL, INSTANCE)):
            if len(values[key]) > 254 or not pattern.fullmatch(values[key]):
                values[key] = ""
        write_json(STATE / "status" / "settings.json", values)

    def compose(self, *args, dotenv=None, timeout=900):
        command = ["docker", "compose", "--env-file", str(dotenv or self.dotenv), "-f", "compose.yaml"]
        if self.automatic:
            command.extend(["-f", "compose.delivery.yaml"])
        command.extend(["-f", "compose.updater.yaml"])
        subprocess.run([*command, *args], cwd=self.bot, env=self.environment, check=True, timeout=timeout)

    def save_settings(self, values):
        if not settings_valid(values, self.automatic):
            raise ValueError("Invalid environment settings")
        existing, info = read_regular(self.dotenv, 1024 * 1024)
        self.projection(self.dotenv)
        candidate = dotenv_candidate(existing, values)
        with tempfile.NamedTemporaryFile(dir=self.bot, prefix=".sdc-env-", delete=False) as out:
            staging = Path(out.name)
            try:
                out.write(candidate)
                out.flush()
                os.fchown(out.fileno(), info.st_uid, info.st_gid)
                os.fchmod(out.fileno(), 0o600)
                os.fsync(out.fileno())
                if self.projection(staging) != values:
                    raise ValueError("Compose did not read the requested values")
                self.compose("config", "--quiet", dotenv=staging, timeout=30)
                current, current_info = read_regular(self.dotenv, 1024 * 1024)
                if current != existing or current_info.st_ino != info.st_ino:
                    raise ValueError("The .env file changed while settings were being validated")
                os.replace(staging, self.dotenv)
            finally:
                staging.unlink(missing_ok=True)
        write_json(STATE / "status" / "settings.json", values)

    def git(self, path, *args, capture=False):
        command = ["runuser", "-u", self.user, "--", "git", "-C", str(path), "-c", "core.hooksPath=/dev/null", *args]
        # Keep the service's private umask for settings, and use standard modes for checked-out source.
        result = subprocess.run(command, check=True, capture_output=capture, text=True, timeout=75, umask=0o022)
        return result.stdout.strip() if capture else None

    def fetch_main(self, path):
        origin = self.git(path, "remote", "get-url", "origin", capture=True)
        expected = "https://github.com/JModify/" + path.name
        if origin not in {expected, expected + ".git"}:
            raise CheckoutError(f"{path.name} uses an unexpected Git origin. Its origin must point to {expected}.")
        if self.git(path, "branch", "--show-current", capture=True) != "main":
            raise CheckoutError(f"{path.name} must be on the main branch.")
        if self.git(path, "status", "--porcelain", "--untracked-files=no", capture=True):
            raise CheckoutError(f"{path.name} has local changes to tracked files. Run git status in that checkout on EC2.")
        self.git(path, "fetch", "--no-tags", "origin", "main")
        head = self.git(path, "rev-parse", "FETCH_HEAD", capture=True)
        if not re.fullmatch(r"[a-f0-9]{40}", head):
            raise CheckoutError(f"Git did not return a valid commit for {path.name}.")
        try:
            self.git(path, "merge-base", "--is-ancestor", "HEAD", head)
        except subprocess.CalledProcessError as error:
            if error.returncode == 1:
                raise CheckoutError(f"{path.name} cannot fast-forward to the fetched main branch. Review its local commits on EC2.") from error
            raise
        return head

    def rebuild(self, pull):
        if pull:
            status("running", "Fetching both main branches.")
            commits = [(repo, self.fetch_main(repo)) for repo in (self.central, self.bot)]
            for repo, commit in commits:
                self.git(repo, "merge", "--ff-only", commit)
        status("running", "Validating Compose and building both images.")
        self.compose("config", "--quiet", timeout=30)
        self.compose("build", "service-desk-central", "digest-bot", timeout=600)
        status("running", "Restarting both services and waiting for health checks.")
        self.compose("up", "--detach", "--no-build", "--force-recreate", "--wait", "--wait-timeout", "420",
                     "service-desk-central", "digest-bot", timeout=450)
        self.snapshot()


def apply_request(request_path, deployment):
    try:
        raw, _ = read_regular(request_path, 4096, owner=1000)
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise ValueError("Invalid request")
        kind = request.get("kind")
        if kind in ("update", "restart") and request.keys() == {"kind"}:
            deployment.rebuild(kind == "update")
            status("succeeded", "Both services passed the Compose startup checks.")
        elif kind == "settings" and request.keys() == {"kind", "values"}:
            status("running", "Validating the environment settings.")
            deployment.save_settings(request["values"])
            status("succeeded", ".env saved. Rebuild the sites to apply the settings.")
        elif kind == "refresh" and request.keys() == {"kind"}:
            deployment.snapshot()
            status("succeeded", "Environment settings reloaded from EC2.")
        else:
            raise ValueError("Unknown maintenance action")
    except CheckoutError as error:
        print(f"Maintenance request failed: {error}", file=sys.stderr)
        status("failed", str(error))
        return 1
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"Maintenance request failed: {type(error).__name__}", file=sys.stderr)
        status("failed", "The request failed. Check the bond-sdc-admin service log on EC2.")
        return 1
    finally:
        request_path.unlink(missing_ok=True)
    return 0


def main():
    deployment = Deployment()
    with (STATE / "host.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if sys.argv[1:] == ["--snapshot"]:
            deployment.snapshot()
            if not (STATE / "status" / "update.json").exists():
                status("ready", "The host updater is ready.")
            return 0
        request = STATE / "requests" / "request.json"
        return apply_request(request, deployment) if os.path.lexists(request) else 0


if __name__ == "__main__":
    sys.exit(main())
