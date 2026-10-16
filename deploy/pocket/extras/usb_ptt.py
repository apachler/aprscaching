#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""Push-to-talk for the ingest's soundcard port through a USB radio interface on an Android phone.

Termux has no /dev/tty* and no /dev/hidraw* for a USB device: Android grants USB access per app, and
`termux-usb -e <command> <device>` runs the command with a file descriptor for the device (the usbfs node,
/dev/bus/usb/BBB/DDD) appended as its last argument. This program drives the interface's keying line through
that descriptor with usbfs control transfers (linux/usbdevice_fs.h), Python's standard library only:

  cdc-dtr / cdc-rts        CDC-ACM SET_CONTROL_LINE_STATE: bmRequestType 0x21, bRequest 0x22, wValue bit 0 DTR,
                           bit 1 RTS, wIndex the communication interface (linux/usb/cdc.h, cdc-acm.c). The AIOC
                           keys on DTR=1 with RTS=0 (its README), which is what cdc-dtr sends.
  cp210x-rts / -dtr        Silicon Labs CP210x SET_MHS: 0x41, 0x07, wValue bit 0 DTR, bit 1 RTS, bits 8 and 9 the
                           write masks, wIndex the interface (cp210x.c); IFC_ENABLE (0x00, 1) first, as the
                           kernel driver's open does. The Digirig keys on RTS.
  ftdi-rts / -dtr          FTDI SIO_SET_MODEM_CTRL: 0x40, 0x01, wValue 0x0101/0x0100 DTR, 0x0202/0x0200 RTS,
                           wIndex 0 on the single-port FT232A/B/R, else the channel, 1 + interface (ftdi_sio.c).
  ch340-rts / -dtr         WCH CH340/CH341 modem control: 0x40, 0xA4, wValue the inverted control bits, RTS
                           bit 6, DTR bit 5 (ch341.c).
  cm108                    C-Media CM108/CM119 GPIO through a HID SET_REPORT: 0x21, 0x09, wValue 0x0200 (an
                           output report, id 0), wIndex the HID interface, the 4-byte report [0, GPIO values,
                           GPIO directions, 0] (the CM108 data sheet's layout, as Hamlib's and Direwolf's cm108.c
                           write it). GPIO3 is the pin most interfaces wire to PTT.

The method is named with --method, or chosen by the device's VID:PID (read from the descriptor: reading a
usbfs node returns the device and configuration descriptors): 10c4:ea60 (CP2102, the Digirig) cp210x-rts,
1209:7388 (the AIOC) cdc-dtr, 0d8c:* (C-Media) cm108 on GPIO3, 0403:* (FTDI) ftdi-rts, 1a86:7523 (CH340)
ch340-rts. Any other device needs --method.

The ingest speaks a line protocol on stdin: KEY, UNKEY and QUIT, each answered OK or ERR <reason>. The answers
go to stderr, because termux-usb captures the command's stdout and prints it only once the command exits; at
start the program answers READY <what it drives>, or ERR <reason> and exits. The line is driven unkeyed at
start, on every error, on stdin's end (the ingest stopped or died), on SIGTERM, SIGINT and SIGHUP, and on
exit, which reports UNKEYED once that last unkey went through. A watchdog unkeys a line keyed longer than
--max-key seconds without a fresh KEY and reports WATCHDOG. Claimed interfaces are released on the way out:
Termux:API keeps its own copy of the descriptor open, so a claim would otherwise outlive this program and
refuse the next one.

  termux-usb -r -e "python3 usb_ptt.py --method cp210x-rts" /dev/bus/usb/001/002
"""

from __future__ import annotations

import argparse
import ctypes
import errno
import fcntl
import os
import select
import signal
import struct
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass, field


# ---- usbfs ioctls (linux/usbdevice_fs.h; the generic _IOC encoding of arm, arm64 and x86) -----------------
def _ioc(direction: int, nr: int, size: int) -> int:
    return (direction << 30) | (size << 16) | (ord("U") << 8) | nr


_IOC_WRITE, _IOC_READ = 1, 2
# struct usbdevfs_ctrltransfer { __u8 bRequestType; __u8 bRequest; __u16 wValue; __u16 wIndex; __u16 wLength;
# __u32 timeout; void *data; }: native alignment puts the pointer at offset 16 on a 64-bit kernel (24 bytes in
# all) and at 12 on a 32-bit one (16 bytes).
CTRL = struct.Struct("@BBHHHIP")
# struct usbdevfs_disconnect_claim { unsigned int interface; unsigned int flags; char driver[256]; }
DISCONNECT_CLAIM = struct.Struct("@II256s")
USBDEVFS_CONTROL = _ioc(_IOC_READ | _IOC_WRITE, 0, CTRL.size)
USBDEVFS_CLAIMINTERFACE = _ioc(_IOC_READ, 15, 4)
USBDEVFS_RELEASEINTERFACE = _ioc(_IOC_READ, 16, 4)
USBDEVFS_DISCONNECT_CLAIM = _ioc(_IOC_READ, 27, DISCONNECT_CLAIM.size)
CTRL_TIMEOUT_MS = 1000

METHODS = (
    "cdc-dtr",
    "cdc-rts",
    "cp210x-rts",
    "cp210x-dtr",
    "ftdi-rts",
    "ftdi-dtr",
    "ch340-rts",
    "ch340-dtr",
    "cm108",
)


@dataclass(frozen=True)
class Ctrl:
    """One control transfer from host to device."""

    request_type: int
    request: int
    value: int
    index: int
    data: bytes = b""


@dataclass
class Device:
    vid: int
    pid: int
    bcd: int
    # (interface number, class, subclass) of alternate setting 0 of each interface of the first configuration
    interfaces: list[tuple[int, int, int]] = field(default_factory=list)

    @property
    def ids(self) -> str:
        return f"{self.vid:04x}:{self.pid:04x}"


@dataclass(frozen=True)
class Plan:
    """What keys one interface: the interface to claim (None for device-level requests), the transfers that
    prepare it, and the transfers that key and unkey."""

    label: str
    claim: int | None
    setup: tuple[Ctrl, ...]
    key: Ctrl
    unkey: Ctrl


def parse_descriptors(raw: bytes) -> Device:
    """The device descriptor and the first configuration's interfaces, from what a usbfs node reads back."""
    if len(raw) < 18 or raw[1] != 0x01:
        raise ValueError("no USB device descriptor in what the device returned")
    vid, pid, bcd = struct.unpack_from("<HHH", raw, 8)
    dev = Device(vid, pid, bcd)
    seen: set[int] = set()
    configs = 0
    pos = raw[0]
    while pos + 2 <= len(raw):
        length, kind = raw[pos], raw[pos + 1]
        if length < 2:
            break
        if kind == 0x02:
            configs += 1
            if configs > 1:
                break
        elif kind == 0x04 and pos + 9 <= len(raw) and raw[pos + 3] == 0 and raw[pos + 2] not in seen:
            seen.add(raw[pos + 2])
            dev.interfaces.append((raw[pos + 2], raw[pos + 5], raw[pos + 6]))
        pos += length
    return dev


def auto_method(dev: Device) -> str:
    """The keying method a known interface uses; raises for an unknown one."""
    if (dev.vid, dev.pid) == (0x10C4, 0xEA60):
        return "cp210x-rts"
    if (dev.vid, dev.pid) == (0x1209, 0x7388):
        return "cdc-dtr"
    if dev.vid == 0x0D8C:
        return "cm108"
    if dev.vid == 0x0403:
        return "ftdi-rts"
    if (dev.vid, dev.pid) == (0x1A86, 0x7523):
        return "ch340-rts"
    raise ValueError(f"device {dev.ids} is not a known radio interface; name the keying line with --method")


def _interface(dev: Device, want: Callable[[int, int], bool], what: str, override: int | None) -> int:
    if override is not None:
        return override
    for number, cls, sub in dev.interfaces:
        if want(cls, sub):
            return number
    raise ValueError(f"device {dev.ids} has no {what} interface; is it the right device?")


def plan(method: str, dev: Device, gpio: int = 3, interface: int | None = None) -> Plan:
    """The transfers `method` needs on `dev`."""
    line = method.rsplit("-", 1)[-1]
    if method in ("cdc-dtr", "cdc-rts"):
        n = _interface(dev, lambda c, s: c == 0x02 and s == 0x02, "CDC-ACM communication", interface)
        on = 0x01 if line == "dtr" else 0x02  # the other line stays clear: the AIOC keys on DTR=1, RTS=0
        return Plan(
            f"{dev.ids} CDC-ACM {line.upper()} (interface {n})",
            n,
            (),
            Ctrl(0x21, 0x22, on, n),
            Ctrl(0x21, 0x22, 0x00, n),
        )
    if method in ("cp210x-rts", "cp210x-dtr"):
        n = _interface(dev, lambda c, s: c == 0xFF, "vendor-specific (CP210x UART)", interface)
        bit = 0x0001 if line == "dtr" else 0x0002
        mask = bit << 8
        return Plan(
            f"{dev.ids} CP210x {line.upper()} (interface {n})",
            n,
            (Ctrl(0x41, 0x00, 0x0001, n),),  # IFC_ENABLE: UART_ENABLE
            Ctrl(0x41, 0x07, mask | bit, n),
            Ctrl(0x41, 0x07, mask, n),
        )
    if method in ("ftdi-rts", "ftdi-dtr"):
        channel = 0 if dev.bcd in (0x0200, 0x0400, 0x0600) else 1 + (interface or 0)
        high, low = (0x0101, 0x0100) if line == "dtr" else (0x0202, 0x0200)
        return Plan(
            f"{dev.ids} FTDI {line.upper()} (channel {channel})",
            None,
            (),
            Ctrl(0x40, 0x01, high, channel),
            Ctrl(0x40, 0x01, low, channel),
        )
    if method in ("ch340-rts", "ch340-dtr"):
        bit = 0x20 if line == "dtr" else 0x40
        return Plan(
            f"{dev.ids} CH340 {line.upper()}",
            None,
            (),
            Ctrl(0x40, 0xA4, ~bit & 0xFFFF, 0),
            Ctrl(0x40, 0xA4, 0xFFFF, 0),
        )
    if method == "cm108":
        if not 1 <= gpio <= 8:
            raise ValueError("the CM108 GPIO is 1 to 8")
        n = _interface(dev, lambda c, s: c == 0x03, "HID", interface)
        mask = 1 << (gpio - 1)
        return Plan(
            f"{dev.ids} CM108 GPIO{gpio} (HID interface {n})",
            n,
            (),
            Ctrl(0x21, 0x09, 0x0200, n, bytes([0, mask, mask, 0])),
            Ctrl(0x21, 0x09, 0x0200, n, bytes([0, 0, mask, 0])),
        )
    raise ValueError(f"unknown method {method!r}; one of {', '.join(METHODS)}")


class Usb:
    """Control transfers and interface claims on a usbfs file descriptor."""

    def __init__(self, fd: int, ioctl: Callable[..., int] = fcntl.ioctl) -> None:
        self.fd = fd
        self.ioctl = ioctl
        self.claimed: list[int] = []

    def control(self, c: Ctrl) -> int:
        buf = ctypes.create_string_buffer(c.data, len(c.data)) if c.data else None
        ptr = ctypes.addressof(buf) if buf is not None else 0
        arg = bytearray(CTRL.pack(c.request_type, c.request, c.value, c.index, len(c.data), CTRL_TIMEOUT_MS, ptr))
        return self.ioctl(self.fd, USBDEVFS_CONTROL, arg)

    def claim(self, n: int) -> None:
        try:
            self.ioctl(self.fd, USBDEVFS_CLAIMINTERFACE, bytearray(struct.pack("@I", n)))
        except OSError as e:
            if e.errno != errno.EBUSY:
                raise
            # A kernel driver (cdc_acm, usbhid) holds it: take it over, as Android's own claimInterface(force) does.
            self.ioctl(self.fd, USBDEVFS_DISCONNECT_CLAIM, bytearray(DISCONNECT_CLAIM.pack(n, 0, b"")))
        self.claimed.append(n)

    def release_all(self) -> None:
        while self.claimed:
            n = self.claimed.pop()
            try:
                self.ioctl(self.fd, USBDEVFS_RELEASEINTERFACE, bytearray(struct.pack("@I", n)))
            except OSError:
                pass


def read_descriptors(fd: int) -> bytes:
    os.lseek(fd, 0, os.SEEK_SET)
    out = b""
    while len(out) < 65536:
        chunk = os.read(fd, 4096)
        if not chunk:
            break
        out += chunk
    return out


class Ptt:
    """One planned keying line on a device."""

    def __init__(self, usb: Usb, p: Plan) -> None:
        self.usb = usb
        self.plan = p

    def open(self) -> None:
        if self.plan.claim is not None:
            self.usb.claim(self.plan.claim)
        for c in self.plan.setup:
            self.usb.control(c)
        self.usb.control(self.plan.unkey)

    def key(self) -> None:
        self.usb.control(self.plan.key)

    def unkey(self) -> None:
        self.usb.control(self.plan.unkey)

    def close(self) -> None:
        try:
            self.unkey()
        finally:
            self.usb.release_all()


class Lines:
    """Lines from a file descriptor, read without Python's buffering so select() sees what is pending."""

    def __init__(self, fd: int) -> None:
        self.fd = fd
        self.buf = b""
        self.eof = False

    def pending(self) -> bool:
        return b"\n" in self.buf

    def wait(self, timeout: float | None) -> bool:
        """Whether a line (or the end) is ready within `timeout` seconds."""
        if self.pending() or self.eof:
            return True
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            left = None if deadline is None else max(0.0, deadline - time.monotonic())
            ready, _, _ = select.select([self.fd], [], [], left)
            if not ready:
                return False
            chunk = os.read(self.fd, 1024)
            if not chunk:
                self.eof = True
                return True
            self.buf += chunk
            if self.pending():
                return True
            if len(self.buf) > 256:
                self.buf = b""  # no command is this long

    def take(self) -> str | None:
        if self.pending():
            line, self.buf = self.buf.split(b"\n", 1)
            return line.decode("ascii", "replace").strip()
        return None


def serve(ptt: Ptt, lines: Lines, say: Callable[[str], None], max_key_s: float, clock=time.monotonic) -> None:
    """Answer KEY, UNKEY and QUIT until QUIT or the end of the input; unkey on any error and on the way out."""
    keyed_at: float | None = None
    try:
        while True:
            timeout = None if keyed_at is None else max(0.0, keyed_at + max_key_s - clock())
            if not lines.wait(timeout):
                ptt.unkey()
                keyed_at = None
                say(f"WATCHDOG keyed over {max_key_s:g} s without a fresh KEY; unkeyed")
                continue
            line = lines.take()
            if line is None:
                return  # the end of the input: the ingest is gone
            cmd = line.upper()
            if not cmd:
                continue
            try:
                if cmd == "KEY":
                    ptt.key()
                    keyed_at = clock()
                    say("OK")
                elif cmd == "UNKEY":
                    keyed_at = None
                    ptt.unkey()
                    say("OK")
                elif cmd == "QUIT":
                    say("OK")
                    return
                else:
                    say(f"ERR unknown command {line[:20]!r}")
            except OSError as e:
                keyed_at = None
                try:
                    ptt.unkey()
                except OSError:
                    pass
                say(f"ERR {cmd.lower()} failed: {os.strerror(e.errno) if e.errno else e}")
    finally:
        ptt.close()


def _stop(signum, _frame):
    raise SystemExit(128 + signum)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="PTT through a USB radio interface, on a termux-usb descriptor.")
    ap.add_argument("--method", default="auto", choices=("auto", *METHODS))
    ap.add_argument("--gpio", type=int, default=3, help="the CM108 GPIO that keys (default 3)")
    ap.add_argument("--interface", type=int, help="the interface to address (default: found from the descriptor)")
    ap.add_argument("--max-key", type=float, default=15.0, help="unkey after this many seconds without a KEY")
    ap.add_argument("fd", type=int, help="the descriptor termux-usb -e appends")
    a = ap.parse_args(argv)

    def say(msg: str) -> None:
        os.write(2, (msg + "\n").encode())

    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, _stop)
    usb = Usb(a.fd)
    ptt: Ptt | None = None
    try:
        try:
            dev = parse_descriptors(read_descriptors(a.fd))
            method = auto_method(dev) if a.method == "auto" else a.method
            ptt = Ptt(usb, plan(method, dev, a.gpio, a.interface))
            ptt.open()
        except (OSError, ValueError) as e:
            ptt = None
            reason = os.strerror(e.errno) if isinstance(e, OSError) and e.errno else str(e)
            say(f"ERR {reason}")
            return 2
        say(f"READY {ptt.plan.label}")
        serve(ptt, Lines(0), say, a.max_key)
    except BrokenPipeError:
        return 3
    finally:
        # serve() unkeys on its way out; this covers a signal or a fault before it ran, and tells the ingest
        if ptt is not None:
            try:
                ptt.unkey()
                say("UNKEYED")
            except OSError:
                pass
        usb.release_all()
    return 0


if __name__ == "__main__":
    sys.exit(main())
