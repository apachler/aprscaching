#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
"""A USB KISS TNC on the phone's USB port, served as KISS over TCP for the ingest.

termux-usb hands this program a file descriptor for the device (Android grants USB access per app, and
Termux has no /dev/bus/usb access of its own). libusb wraps that descriptor (libusb_wrap_sys_device, with
device discovery switched off as Android requires), the program drives the device as a CDC-ACM serial port,
and it serves the raw KISS stream on 127.0.0.1:<port> to one client: the ingest, as KISS_TNC_HOST /
KISS_TNC_PORT. It is a transport, never a trust source: what the TNC hears is a local TNC's hearing like any
other.

Receive-only by default: every frame the client sends toward the radio is dropped, with one warning. With
--tx the client's KISS data frames reach the radio through a watchdog: at most --tx-per-min frames a minute
(burst --tx-burst), each at most 330 bytes, and never KISS "exit" (0xFF) frames. The station's scripts
enable --tx only when USB_KISS_TX=1 and the operator's callsign is control-verified.

Only CDC-ACM devices work without their own driver. FTDI, Silicon Labs CP210x and WCH CH340 chips are
refused with their name.

Run by deploy/pocket/extras/usb-kiss.sh, which asks termux-usb for the device and restarts this program
when the device goes away. --serial PATH drives a serial device node or pty instead (for tests on a PC).
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.util
import os
import selectors
import socket
import sys
import threading
import time

FEND, FESC, TFEND, TFESC = 0xC0, 0xDB, 0xDC, 0xDD
MAX_FRAME = 330

# USB vendors whose serial chips need a vendor driver rather than CDC-ACM.
VENDOR_CHIPS = {0x0403: "FTDI", 0x10C4: "Silicon Labs CP210x", 0x1A86: "WCH CH340/CH341", 0x067B: "Prolific PL2303"}


def log(msg: str) -> None:
    print(f"[usb-kiss] {msg}", flush=True)


# ---- KISS framing ---------------------------------------------------------------------------------------
class Deframer:
    """Splits a KISS byte stream into frames (the raw bytes between FENDs, still escaped)."""

    def __init__(self) -> None:
        self.buf = bytearray()
        self.inside = False

    def feed(self, data: bytes) -> list[bytes]:
        out: list[bytes] = []
        for b in data:
            if b == FEND:
                if self.buf:
                    out.append(bytes(self.buf))
                self.buf.clear()
                self.inside = True
            elif self.inside:
                self.buf.append(b)
                if len(self.buf) > 2 * MAX_FRAME + 8:  # runaway: drop and resync at the next FEND
                    self.buf.clear()
                    self.inside = False
        return out


def unescape(frame: bytes) -> bytes:
    out = bytearray()
    esc = False
    for b in frame:
        if esc:
            out.append(FEND if b == TFEND else FESC if b == TFESC else b)
            esc = False
        elif b == FESC:
            esc = True
        else:
            out.append(b)
    return bytes(out)


class TxGate:
    """What may go from the client to the radio: nothing when receive-only; with transmit, KISS data frames
    under a token-bucket watchdog, size-limited, and never the 'exit KISS' command."""

    def __init__(self, tx: bool, per_min: int = 6, burst: int = 3, clock=time.monotonic) -> None:
        self.tx = tx
        self.rate = per_min / 60.0
        self.burst = float(burst)
        self.tokens = float(burst)
        self.clock = clock
        self.last = clock()
        self.warned: set[str] = set()

    def _warn_once(self, key: str, msg: str) -> None:
        if key not in self.warned:
            self.warned.add(key)
            log(msg)

    def allow(self, frame: bytes) -> bool:
        if not self.tx:
            self._warn_once("rx", "receive-only: frames from the client toward the radio are dropped")
            return False
        raw = unescape(frame)
        if not raw:
            return False
        cmd = raw[0] & 0x0F
        if raw[0] == 0xFF:
            self._warn_once("exit", "dropped a KISS exit frame: the TNC stays in KISS mode")
            return False
        if cmd != 0:  # TNC parameters (TXDELAY, persistence, …) pass without using the TX budget
            return 1 <= cmd <= 6
        if len(raw) - 1 > MAX_FRAME:
            self._warn_once("size", f"dropped a frame over {MAX_FRAME} bytes")
            return False
        now = self.clock()
        self.tokens = min(self.burst, self.tokens + (now - self.last) * self.rate)
        self.last = now
        if self.tokens < 1:
            log("transmit watchdog: over the frame rate, frame dropped")
            return False
        self.tokens -= 1
        return True


# ---- serial transports ----------------------------------------------------------------------------------
class SerialPath:
    """A serial device node or pty, in raw mode."""

    def __init__(self, path: str, baud: int) -> None:
        import termios
        import tty

        self.fd = os.open(path, os.O_RDWR | os.O_NOCTTY)
        try:
            tty.setraw(self.fd)
            attrs = termios.tcgetattr(self.fd)
            speed = getattr(termios, f"B{baud}", None)
            if speed is not None:
                attrs[4] = attrs[5] = speed
                termios.tcsetattr(self.fd, termios.TCSANOW, attrs)
        except termios.error:
            pass  # a socket or plain file: nothing to configure

    def read(self, timeout: float) -> bytes:
        sel = selectors.DefaultSelector()
        sel.register(self.fd, selectors.EVENT_READ)
        ready = sel.select(timeout)
        sel.close()
        if not ready:
            return b""
        data = os.read(self.fd, 4096)
        if not data:
            raise ConnectionError("the serial device closed")
        return data

    def write(self, data: bytes) -> None:
        os.write(self.fd, data)

    def close(self) -> None:
        os.close(self.fd)


class LibUsb:
    """The few libusb-1.0 calls a CDC-ACM device needs, through ctypes (Termux: pkg install libusb)."""

    OPTION_NO_DEVICE_DISCOVERY = 2

    def __init__(self) -> None:
        name = ctypes.util.find_library("usb-1.0") or "libusb-1.0.so"
        self.lib = ctypes.CDLL(name)
        L = self.lib
        L.libusb_set_option.argtypes = [ctypes.c_void_p, ctypes.c_int]
        L.libusb_init.argtypes = [ctypes.POINTER(ctypes.c_void_p)]
        L.libusb_wrap_sys_device.argtypes = [ctypes.c_void_p, ctypes.c_long, ctypes.POINTER(ctypes.c_void_p)]
        L.libusb_get_device.argtypes = [ctypes.c_void_p]
        L.libusb_get_device.restype = ctypes.c_void_p
        L.libusb_get_device_descriptor.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
        L.libusb_get_active_config_descriptor.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
        L.libusb_free_config_descriptor.argtypes = [ctypes.c_void_p]
        L.libusb_claim_interface.argtypes = [ctypes.c_void_p, ctypes.c_int]
        L.libusb_release_interface.argtypes = [ctypes.c_void_p, ctypes.c_int]
        L.libusb_control_transfer.argtypes = [
            ctypes.c_void_p,
            ctypes.c_uint8,
            ctypes.c_uint8,
            ctypes.c_uint16,
            ctypes.c_uint16,
            ctypes.c_char_p,
            ctypes.c_uint16,
            ctypes.c_uint,
        ]
        L.libusb_bulk_transfer.argtypes = [
            ctypes.c_void_p,
            ctypes.c_uint8,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.POINTER(ctypes.c_int),
            ctypes.c_uint,
        ]
        L.libusb_close.argtypes = [ctypes.c_void_p]
        L.libusb_exit.argtypes = [ctypes.c_void_p]


# struct libusb_config_descriptor / interface / interface_descriptor / endpoint_descriptor (libusb.h)
class _Endpoint(ctypes.Structure):
    _fields_ = [
        ("bLength", ctypes.c_uint8),
        ("bDescriptorType", ctypes.c_uint8),
        ("bEndpointAddress", ctypes.c_uint8),
        ("bmAttributes", ctypes.c_uint8),
        ("wMaxPacketSize", ctypes.c_uint16),
        ("bInterval", ctypes.c_uint8),
        ("bRefresh", ctypes.c_uint8),
        ("bSynchAddress", ctypes.c_uint8),
        ("extra", ctypes.c_void_p),
        ("extra_length", ctypes.c_int),
    ]


class _AltSetting(ctypes.Structure):
    _fields_ = [
        ("bLength", ctypes.c_uint8),
        ("bDescriptorType", ctypes.c_uint8),
        ("bInterfaceNumber", ctypes.c_uint8),
        ("bAlternateSetting", ctypes.c_uint8),
        ("bNumEndpoints", ctypes.c_uint8),
        ("bInterfaceClass", ctypes.c_uint8),
        ("bInterfaceSubClass", ctypes.c_uint8),
        ("bInterfaceProtocol", ctypes.c_uint8),
        ("iInterface", ctypes.c_uint8),
        ("endpoint", ctypes.POINTER(_Endpoint)),
        ("extra", ctypes.c_void_p),
        ("extra_length", ctypes.c_int),
    ]


class _Interface(ctypes.Structure):
    _fields_ = [("altsetting", ctypes.POINTER(_AltSetting)), ("num_altsetting", ctypes.c_int)]


class _Config(ctypes.Structure):
    _fields_ = [
        ("bLength", ctypes.c_uint8),
        ("bDescriptorType", ctypes.c_uint8),
        ("wTotalLength", ctypes.c_uint16),
        ("bNumInterfaces", ctypes.c_uint8),
        ("bConfigurationValue", ctypes.c_uint8),
        ("iConfiguration", ctypes.c_uint8),
        ("bmAttributes", ctypes.c_uint8),
        ("MaxPower", ctypes.c_uint8),
        ("interface", ctypes.POINTER(_Interface)),
        ("extra", ctypes.c_void_p),
        ("extra_length", ctypes.c_int),
    ]


def pick_cdc_acm(interfaces: list[tuple[int, int, int, list[tuple[int, int]]]]) -> tuple[int, int, int, int] | None:
    """(comm interface, data interface, bulk IN, bulk OUT) of a CDC-ACM function, from
    [(number, class, subclass, [(endpoint address, attributes)])], or None."""
    comm = next((n for n, c, s, _ in interfaces if c == 0x02 and s == 0x02), None)
    for n, c, _s, eps in interfaces:
        if c != 0x0A:
            continue
        bulk = [a for a, attr in eps if attr & 0x03 == 0x02]
        ep_in = next((a for a in bulk if a & 0x80), None)
        ep_out = next((a for a in bulk if not a & 0x80), None)
        if ep_in is not None and ep_out is not None:
            return (comm if comm is not None else n, n, ep_in, ep_out)
    return None


def not_cdc_acm(vid: int, pid: int) -> str:
    """Why a device that is not CDC-ACM is refused, naming its chip when the vendor is known."""
    chip = VENDOR_CHIPS.get(vid)
    return (
        f"device {vid:04x}:{pid:04x} is not a CDC-ACM serial device"
        + (f": it has a {chip} chip, which needs its own driver" if chip else "")
        + ". Only CDC-ACM TNCs work here; see the compatibility table in docs/run/pocket/field-station.md."
    )


class UsbCdcAcm:
    """A CDC-ACM device from the file descriptor termux-usb hands over."""

    def __init__(self, fd: int, baud: int) -> None:
        self.u = LibUsb()
        L = self.u.lib
        L.libusb_set_option(None, LibUsb.OPTION_NO_DEVICE_DISCOVERY)
        self.ctx = ctypes.c_void_p()
        if L.libusb_init(ctypes.byref(self.ctx)) != 0:
            raise OSError("libusb_init failed")
        self.h = ctypes.c_void_p()
        if L.libusb_wrap_sys_device(self.ctx, fd, ctypes.byref(self.h)) != 0:
            raise OSError("libusb could not open the device from its file descriptor")
        dev = L.libusb_get_device(self.h)
        desc = ctypes.create_string_buffer(18)
        L.libusb_get_device_descriptor(dev, desc)
        vid = int.from_bytes(desc.raw[8:10], "little")
        pid = int.from_bytes(desc.raw[10:12], "little")
        cfg_p = ctypes.c_void_p()
        if L.libusb_get_active_config_descriptor(dev, ctypes.byref(cfg_p)) != 0:
            raise OSError("cannot read the device's configuration")
        cfg = ctypes.cast(cfg_p, ctypes.POINTER(_Config)).contents
        ifaces = []
        for i in range(cfg.bNumInterfaces):
            alt = cfg.interface[i].altsetting[0]
            eps = [(alt.endpoint[e].bEndpointAddress, alt.endpoint[e].bmAttributes) for e in range(alt.bNumEndpoints)]
            ifaces.append((alt.bInterfaceNumber, alt.bInterfaceClass, alt.bInterfaceSubClass, eps))
        L.libusb_free_config_descriptor(cfg_p)
        picked = pick_cdc_acm(ifaces)
        if picked is None:
            raise SystemExit(not_cdc_acm(vid, pid))
        self.comm, self.data, self.ep_in, self.ep_out = picked
        for n in {self.comm, self.data}:
            if L.libusb_claim_interface(self.h, n) != 0:
                raise OSError(f"cannot claim USB interface {n}")
        line = baud.to_bytes(4, "little") + bytes([0, 0, 8])  # 8N1
        L.libusb_control_transfer(self.h, 0x21, 0x20, 0, self.comm, line, 7, 1000)  # SET_LINE_CODING
        L.libusb_control_transfer(self.h, 0x21, 0x22, 0x03, self.comm, None, 0, 1000)  # DTR + RTS
        log(f"device {vid:04x}:{pid:04x}: CDC-ACM, {baud} baud")

    def read(self, timeout: float) -> bytes:
        buf = ctypes.create_string_buffer(4096)
        got = ctypes.c_int()
        rc = self.u.lib.libusb_bulk_transfer(self.h, self.ep_in, buf, 4096, ctypes.byref(got), int(timeout * 1000))
        if rc in (0, -7):  # LIBUSB_SUCCESS, LIBUSB_ERROR_TIMEOUT
            return buf.raw[: got.value]
        raise ConnectionError(f"the USB device stopped answering (libusb error {rc})")

    def write(self, data: bytes) -> None:
        got = ctypes.c_int()
        rc = self.u.lib.libusb_bulk_transfer(self.h, self.ep_out, data, len(data), ctypes.byref(got), 2000)
        if rc != 0:
            raise ConnectionError(f"write to the USB device failed (libusb error {rc})")

    def close(self) -> None:
        L = self.u.lib
        for n in {self.comm, self.data}:
            L.libusb_release_interface(self.h, n)
        L.libusb_close(self.h)
        L.libusb_exit(self.ctx)


# ---- the bridge -----------------------------------------------------------------------------------------
class Bridge:
    def __init__(self, serial, listen: socket.socket, gate: TxGate) -> None:
        self.serial = serial
        self.listen = listen
        self.gate = gate
        self.client: socket.socket | None = None
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.error: BaseException | None = None

    def _radio_to_client(self) -> None:
        try:
            while not self.stop.is_set():
                data = self.serial.read(0.2)
                if not data:
                    continue
                with self.lock:
                    c = self.client
                if c is not None:
                    try:
                        c.sendall(data)
                    except OSError:
                        self._drop_client()
        except BaseException as e:  # a gone device ends the bridge; the wrapper restarts it
            self.error = e
            self.stop.set()

    def _drop_client(self) -> None:
        with self.lock:
            if self.client is not None:
                try:
                    self.client.close()
                finally:
                    self.client = None
                log("client disconnected")

    def run(self) -> None:
        reader = threading.Thread(target=self._radio_to_client, daemon=True)
        reader.start()
        sel = selectors.DefaultSelector()
        sel.register(self.listen, selectors.EVENT_READ, "listen")
        deframer = Deframer()
        while not self.stop.is_set():
            for key, _ in sel.select(0.2):
                if key.data == "listen":
                    conn, addr = self.listen.accept()
                    with self.lock:
                        busy = self.client is not None
                    if busy:
                        log(f"refused a second client from {addr[0]}: one client at a time")
                        conn.close()
                        continue
                    with self.lock:
                        self.client = conn
                    deframer = Deframer()
                    sel.register(conn, selectors.EVENT_READ, "client")
                    log(f"client connected from {addr[0]}")
                else:
                    try:
                        data = key.fileobj.recv(4096)
                    except OSError:
                        data = b""
                    if not data:
                        sel.unregister(key.fileobj)
                        self._drop_client()
                        continue
                    for frame in deframer.feed(data):
                        if self.gate.allow(frame):
                            self.serial.write(bytes([FEND]) + frame + bytes([FEND]))
        sel.close()
        self._drop_client()
        if self.error is not None:
            raise self.error


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="A USB KISS TNC served as KISS over TCP.")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--fd", type=int, help="the file descriptor termux-usb -e passes")
    src.add_argument("--serial", help="a serial device node or pty instead of USB")
    ap.add_argument("--baud", type=int, default=9600)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8001)
    ap.add_argument("--tx", action="store_true", help="pass KISS data frames to the radio (off: receive-only)")
    ap.add_argument("--tx-per-min", type=int, default=6)
    ap.add_argument("--tx-burst", type=int, default=3)
    a = ap.parse_args(argv)
    if a.host not in ("127.0.0.1", "localhost", "::1"):
        ap.error("--host must be a loopback address: the KISS port has no authentication")
    serial = UsbCdcAcm(a.fd, a.baud) if a.fd is not None else SerialPath(a.serial, a.baud)
    listen = socket.create_server((a.host, a.port), reuse_port=False)
    log(f"KISS over TCP on {a.host}:{a.port}, {'transmit enabled (watchdog on)' if a.tx else 'receive-only'}")
    try:
        Bridge(serial, listen, TxGate(a.tx, a.tx_per_min, a.tx_burst)).run()
    except ConnectionError as e:
        log(str(e))
        return 3
    finally:
        listen.close()
        serial.close()
    return 0


if __name__ == "__main__":
    # termux-usb -e appends the file descriptor to the command, so usb-kiss.sh ends it with --fd.
    sys.exit(main())
