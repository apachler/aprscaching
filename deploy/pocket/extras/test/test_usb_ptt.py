# SPDX-License-Identifier: AGPL-3.0-or-later
"""The USB PTT helper without a USB device: a fake ioctl decodes each usbfs request it is handed."""

import ctypes
import errno
import os
import signal
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import usb_ptt as u  # noqa: E402


def descriptor(vid, pid, bcd=0x0100, interfaces=()):
    """A device descriptor and one configuration with `interfaces` [(number, class, subclass)]."""
    dev = struct.pack("<BBHBBBBHHHBBBB", 18, 1, 0x0200, 0, 0, 0, 64, vid, pid, bcd, 1, 2, 3, 1)
    body = b"".join(struct.pack("<BBBBBBBBB", 9, 4, n, 0, 0, c, s, 0, 0) for n, c, s in interfaces)
    cfg = struct.pack("<BBHBBBBB", 9, 2, 9 + len(body), len(interfaces), 1, 0, 0x80, 50)
    return dev + cfg + body


class FakeIoctl:
    """Records control transfers as (bRequestType, bRequest, wValue, wIndex, data) and claims by interface."""

    def __init__(self, busy=(), fail_control=False):
        self.transfers = []
        self.claims = []
        self.released = []
        self.busy = set(busy)
        self.fail_control = fail_control

    def __call__(self, fd, request, arg):
        if request == u.USBDEVFS_CONTROL:
            rt, req, value, index, length, timeout, ptr = u.CTRL.unpack(bytes(arg))
            assert timeout == u.CTRL_TIMEOUT_MS
            data = ctypes.string_at(ptr, length) if length else b""
            if self.fail_control:
                raise OSError(errno.ENODEV, "No such device")
            self.transfers.append((rt, req, value, index, data))
            return length
        if request == u.USBDEVFS_CLAIMINTERFACE:
            (n,) = struct.unpack("@I", bytes(arg))
            if n in self.busy:
                raise OSError(errno.EBUSY, "Device or resource busy")
            self.claims.append(("claim", n))
            return 0
        if request == u.USBDEVFS_DISCONNECT_CLAIM:
            n, flags, _driver = u.DISCONNECT_CLAIM.unpack(bytes(arg))
            assert flags == 0
            self.claims.append(("disconnect-claim", n))
            return 0
        if request == u.USBDEVFS_RELEASEINTERFACE:
            self.released.append(struct.unpack("@I", bytes(arg))[0])
            return 0
        raise AssertionError(f"unexpected ioctl {request:#x}")


class Encoding(unittest.TestCase):
    def test_ioctl_numbers_match_the_kernel_header(self):
        # _IOWR('U', 0, struct usbdevfs_ctrltransfer): 24 bytes on a 64-bit kernel, 16 on a 32-bit one
        size = 24 if struct.calcsize("P") == 8 else 16
        self.assertEqual(u.CTRL.size, size)
        self.assertEqual(u.USBDEVFS_CONTROL, 0xC0005500 | (size << 16))
        self.assertEqual(u.USBDEVFS_CLAIMINTERFACE, 0x8004550F)
        self.assertEqual(u.USBDEVFS_RELEASEINTERFACE, 0x80045510)
        self.assertEqual(u.USBDEVFS_DISCONNECT_CLAIM, 0x8108551B)

    def test_ctrltransfer_layout(self):
        raw = u.CTRL.pack(0x21, 0x22, 0x0001, 4, 0, 1000, 0x1122334455667788 if u.CTRL.size == 24 else 0x11223344)
        self.assertEqual(raw[:8], bytes([0x21, 0x22, 0x01, 0x00, 0x04, 0x00, 0x00, 0x00]))
        self.assertEqual(raw[8:12], (1000).to_bytes(4, "little"))
        if u.CTRL.size == 24:
            self.assertEqual(raw[16:24], (0x1122334455667788).to_bytes(8, "little"))

    def test_parses_ids_and_interfaces(self):
        d = u.parse_descriptors(descriptor(0x1209, 0x7388, interfaces=[(0, 1, 1), (3, 2, 2), (4, 0x0A, 0), (5, 3, 0)]))
        self.assertEqual(d.ids, "1209:7388")
        self.assertEqual(d.interfaces, [(0, 1, 1), (3, 2, 2), (4, 0x0A, 0), (5, 3, 0)])
        with self.assertRaises(ValueError):
            u.parse_descriptors(b"\x00" * 4)


class Methods(unittest.TestCase):
    def test_auto_detects_the_known_interfaces(self):
        cases = {
            (0x10C4, 0xEA60): "cp210x-rts",
            (0x1209, 0x7388): "cdc-dtr",
            (0x0D8C, 0x0012): "cm108",
            (0x0D8C, 0x013C): "cm108",
            (0x0403, 0x6001): "ftdi-rts",
            (0x1A86, 0x7523): "ch340-rts",
        }
        for (vid, pid), method in cases.items():
            self.assertEqual(u.auto_method(u.Device(vid, pid, 0)), method)
        with self.assertRaisesRegex(ValueError, "--method"):
            u.auto_method(u.Device(0x1234, 0x5678, 0))

    def test_cdc_acm(self):
        d = u.parse_descriptors(descriptor(0x1209, 0x7388, interfaces=[(0, 1, 1), (3, 2, 2), (4, 0x0A, 0)]))
        p = u.plan("cdc-dtr", d)
        self.assertEqual((p.claim, p.key, p.unkey), (3, u.Ctrl(0x21, 0x22, 0x01, 3), u.Ctrl(0x21, 0x22, 0x00, 3)))
        self.assertEqual(u.plan("cdc-rts", d).key, u.Ctrl(0x21, 0x22, 0x02, 3))
        with self.assertRaisesRegex(ValueError, "CDC-ACM"):
            u.plan("cdc-dtr", u.Device(0x1209, 0x7388, 0, [(0, 1, 1)]))

    def test_cp210x(self):
        d = u.parse_descriptors(descriptor(0x10C4, 0xEA60, interfaces=[(0, 0xFF, 0)]))
        p = u.plan("cp210x-rts", d)
        self.assertEqual(p.claim, 0)
        self.assertEqual(p.setup, (u.Ctrl(0x41, 0x00, 0x0001, 0),))
        self.assertEqual((p.key, p.unkey), (u.Ctrl(0x41, 0x07, 0x0202, 0), u.Ctrl(0x41, 0x07, 0x0200, 0)))
        p = u.plan("cp210x-dtr", d)
        self.assertEqual((p.key.value, p.unkey.value), (0x0101, 0x0100))

    def test_ftdi(self):
        p = u.plan("ftdi-rts", u.Device(0x0403, 0x6001, 0x0600))
        self.assertIsNone(p.claim)
        self.assertEqual((p.key, p.unkey), (u.Ctrl(0x40, 0x01, 0x0202, 0), u.Ctrl(0x40, 0x01, 0x0200, 0)))
        p = u.plan("ftdi-dtr", u.Device(0x0403, 0x6015, 0x1000))  # FT-X: channel A is 1
        self.assertEqual((p.key, p.unkey), (u.Ctrl(0x40, 0x01, 0x0101, 1), u.Ctrl(0x40, 0x01, 0x0100, 1)))

    def test_ch340_inverts_the_bits(self):
        p = u.plan("ch340-rts", u.Device(0x1A86, 0x7523, 0))
        self.assertEqual((p.key, p.unkey), (u.Ctrl(0x40, 0xA4, 0xFFBF, 0), u.Ctrl(0x40, 0xA4, 0xFFFF, 0)))
        self.assertEqual(u.plan("ch340-dtr", u.Device(0x1A86, 0x7523, 0)).key.value, 0xFFDF)

    def test_cm108_report(self):
        d = u.parse_descriptors(descriptor(0x0D8C, 0x0012, interfaces=[(0, 1, 1), (1, 1, 2), (2, 1, 2), (3, 3, 0)]))
        p = u.plan("cm108", d, gpio=3)
        self.assertEqual(p.claim, 3)
        self.assertEqual(p.key, u.Ctrl(0x21, 0x09, 0x0200, 3, bytes([0, 4, 4, 0])))
        self.assertEqual(p.unkey, u.Ctrl(0x21, 0x09, 0x0200, 3, bytes([0, 0, 4, 0])))
        self.assertEqual(u.plan("cm108", d, gpio=1).key.data, bytes([0, 1, 1, 0]))
        with self.assertRaises(ValueError):
            u.plan("cm108", d, gpio=9)


class Driving(unittest.TestCase):
    def setUp(self):
        self.dev = u.parse_descriptors(descriptor(0x0D8C, 0x0012, interfaces=[(0, 1, 1), (3, 3, 0)]))

    def test_open_claims_and_unkeys_and_sends_the_data_buffer(self):
        io = FakeIoctl()
        ptt = u.Ptt(u.Usb(7, io), u.plan("cm108", self.dev))
        ptt.open()
        ptt.key()
        ptt.close()
        self.assertEqual(io.claims, [("claim", 3)])
        self.assertEqual([t[4] for t in io.transfers], [bytes([0, 0, 4, 0]), bytes([0, 4, 4, 0]), bytes([0, 0, 4, 0])])
        self.assertEqual(io.released, [3])

    def test_takes_an_interface_from_a_kernel_driver(self):
        io = FakeIoctl(busy={3})
        u.Ptt(u.Usb(7, io), u.plan("cm108", self.dev)).open()
        self.assertEqual(io.claims, [("disconnect-claim", 3)])


class Protocol(unittest.TestCase):
    def run_serve(self, script, io=None, max_key=5.0, clock=None):
        io = io or FakeIoctl()
        dev = u.parse_descriptors(descriptor(0x10C4, 0xEA60, interfaces=[(0, 0xFF, 0)]))
        ptt = u.Ptt(u.Usb(7, io), u.plan("cp210x-rts", dev))
        ptt.open()
        r, w = os.pipe()
        os.write(w, script)
        os.close(w)
        said = []
        try:
            u.serve(ptt, u.Lines(r), said.append, max_key, **({"clock": clock} if clock else {}))
        finally:
            os.close(r)
        return said, [t[2] for t in io.transfers if t[1] == 0x07], io

    def test_key_unkey_quit(self):
        said, mhs, io = self.run_serve(b"KEY\nUNKEY\nbogus\nQUIT\nKEY\n")
        self.assertEqual(said, ["OK", "OK", "ERR unknown command 'bogus'", "OK"])
        # unkey at open, key, unkey, and the unkey on the way out; the KEY after QUIT is never read
        self.assertEqual(mhs, [0x0200, 0x0202, 0x0200, 0x0200])
        self.assertEqual(io.released, [0])

    def test_end_of_input_unkeys(self):
        said, mhs, _ = self.run_serve(b"KEY\n")
        self.assertEqual(said, ["OK"])
        self.assertEqual(mhs[-1], 0x0200)
        self.assertEqual(mhs, [0x0200, 0x0202, 0x0200])

    def test_a_failed_transfer_answers_err(self):
        io = FakeIoctl()
        dev = u.parse_descriptors(descriptor(0x10C4, 0xEA60, interfaces=[(0, 0xFF, 0)]))
        ptt = u.Ptt(u.Usb(7, io), u.plan("cp210x-rts", dev))
        ptt.open()
        io.fail_control = True
        r, w = os.pipe()
        os.write(w, b"KEY\n")
        os.close(w)
        said = []
        with self.assertRaises(OSError):  # the unkey on the way out fails too: the device is gone
            u.serve(ptt, u.Lines(r), said.append, 5.0)
        os.close(r)
        self.assertEqual(said, ["ERR key failed: No such device"])

    def test_watchdog_unkeys_a_line_keyed_too_long(self):
        io = FakeIoctl()
        dev = u.parse_descriptors(descriptor(0x10C4, 0xEA60, interfaces=[(0, 0xFF, 0)]))
        ptt = u.Ptt(u.Usb(7, io), u.plan("cp210x-rts", dev))
        ptt.open()
        r, w = os.pipe()
        os.write(w, b"KEY\n")
        said = []

        def say(msg):
            said.append(msg)
            if msg.startswith("WATCHDOG"):
                os.close(w)  # end the input once the watchdog fired

        u.serve(ptt, u.Lines(r), say, 0.05)
        os.close(r)
        self.assertEqual(said[0], "OK")
        self.assertTrue(said[1].startswith("WATCHDOG keyed over 0.05 s"))
        mhs = [t[2] for t in io.transfers if t[1] == 0x07]
        self.assertEqual(mhs, [0x0200, 0x0202, 0x0200, 0x0200])


class Main(unittest.TestCase):
    def test_refuses_an_unknown_device_with_err(self):
        handlers = {s: signal.getsignal(s) for s in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
        err_r, err_w = os.pipe()
        saved = os.dup(2)
        with tempfile.TemporaryFile() as f:
            f.write(descriptor(0x1234, 0x5678, interfaces=[(0, 0xFF, 0)]))
            f.flush()
            os.dup2(err_w, 2)
            try:
                code = u.main([str(f.fileno())])
            finally:
                os.dup2(saved, 2)
                os.close(saved)
                os.close(err_w)
                for s, h in handlers.items():
                    signal.signal(s, h)
        out = os.read(err_r, 4096).decode()
        os.close(err_r)
        self.assertEqual(code, 2)
        self.assertRegex(out, r"^ERR device 1234:5678 is not a known radio interface")


if __name__ == "__main__":
    unittest.main()
