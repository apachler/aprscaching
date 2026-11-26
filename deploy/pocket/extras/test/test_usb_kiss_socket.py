# SPDX-License-Identifier: AGPL-3.0-or-later
"""The USB KISS bridge as usb-kiss.sh runs it, with a pty for the radio: it serves its one client on a Unix
socket in a private directory and holds no TCP socket at all. On Android every app shares loopback, so a TCP
port lets any app key the radio once transmit is on, or bind the port first and feed the ingest frames that
count as this site's own hearing. A socket file left by a killed bridge is replaced at the next start; a live
socket or any other file at the path is not."""

import os
import pty
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import unittest

BRIDGE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "usb_kiss_bridge.py")
FRAME = b"\xc0\x00ANY-LOCAL-APP-FRAME\xc0"


def socket_inodes(pid: int) -> set[str]:
    """The inodes of every socket the process holds open."""
    out = set()
    for fd in os.listdir(f"/proc/{pid}/fd"):
        try:
            link = os.readlink(f"/proc/{pid}/fd/{fd}")
        except OSError:
            continue
        if link.startswith("socket:["):
            out.add(link[8:-1])
    return out


def tcp_inodes() -> set[str]:
    """The inodes of every TCP socket (IPv4 and IPv6) on this machine, listening or not."""
    out = set()
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(table) as f:
                next(f)
                out.update(line.split()[9] for line in f)
        except FileNotFoundError:
            pass
    return out


class SocketBridgeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="acs-kiss-")
        self.run_dir = os.path.join(self.tmp.name, "run")
        self.path = os.path.join(self.run_dir, "kiss.sock")
        self.radio, follower = pty.openpty()
        self.tty = os.ttyname(follower)
        self.procs = []

    def tearDown(self):
        for p in self.procs:
            if p.poll() is None:
                p.kill()
            p.wait()
            p.stdout.close()
        os.close(self.radio)
        self.tmp.cleanup()

    def bridge(self, *extra):
        p = subprocess.Popen(
            [sys.executable, "-I", BRIDGE, "--serial", self.tty, "--socket", self.path, *extra],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        self.procs.append(p)
        return p

    def wait_listening(self, p):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if p.poll() is not None:
                self.fail(f"the bridge exited: {p.stdout.read().decode()}")
            try:
                c = socket.socket(socket.AF_UNIX)
                c.connect(self.path)
                return c
            except OSError:
                c.close()
                time.sleep(0.05)
        self.fail("the bridge did not listen on its socket")

    def radio_got(self):
        os.set_blocking(self.radio, False)
        time.sleep(0.4)
        try:
            return os.read(self.radio, 100)
        except BlockingIOError:
            return b""

    def test_no_tcp_client_reaches_the_bridge_with_tx(self):
        p = self.bridge("--tx")
        client = self.wait_listening(p)
        held = socket_inodes(p.pid)
        self.assertTrue(held, "the bridge holds no socket at all: the check would prove nothing")
        self.assertEqual(held & tcp_inodes(), set(), "the bridge holds a TCP socket")
        client.sendall(FRAME)
        self.assertIn(b"ANY-LOCAL-APP-FRAME", self.radio_got())  # the socket's own client does transmit
        client.close()

    def test_the_socket_is_private(self):
        p = self.bridge()
        self.wait_listening(p).close()
        self.assertTrue(stat.S_ISSOCK(os.lstat(self.path).st_mode))
        self.assertEqual(stat.S_IMODE(os.stat(self.run_dir).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o600)

    def test_an_existing_run_directory_is_made_private(self):
        os.makedirs(self.run_dir)
        os.chmod(self.run_dir, 0o755)
        p = self.bridge()
        self.wait_listening(p).close()
        self.assertEqual(stat.S_IMODE(os.stat(self.run_dir).st_mode), 0o700)

    def test_a_socket_left_by_a_killed_bridge_is_replaced(self):
        first = self.bridge()
        self.wait_listening(first).close()
        first.send_signal(signal.SIGKILL)
        first.wait()
        self.assertTrue(stat.S_ISSOCK(os.lstat(self.path).st_mode), "SIGKILL left no socket file to test with")
        second = self.bridge()
        self.wait_listening(second).close()

    def test_a_live_socket_is_not_taken(self):
        first = self.bridge()
        self.wait_listening(first).close()
        second = self.bridge()
        self.assertNotEqual(second.wait(10), 0)
        self.assertIn(b"listens on", second.stdout.read())
        self.wait_listening(first).close()  # the first one still serves

    def test_a_file_that_is_not_a_socket_is_left(self):
        os.makedirs(self.run_dir, mode=0o700)
        with open(self.path, "w") as f:
            f.write("keep me")
        p = self.bridge()
        self.assertNotEqual(p.wait(10), 0)
        with open(self.path) as f:
            self.assertEqual(f.read(), "keep me")

    def test_only_an_absolute_path(self):
        for bad in ("@kiss", "run/kiss.sock"):
            r = subprocess.run(
                [sys.executable, "-I", BRIDGE, "--serial", self.tty, "--socket", bad],
                capture_output=True,
                timeout=10,
            )
            self.assertEqual(r.returncode, 2, bad)


if __name__ == "__main__":
    unittest.main()
