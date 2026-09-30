# SPDX-License-Identifier: AGPL-3.0-or-later
"""The USB KISS bridge without a USB device: a socket pair stands in for the serial port."""

import os
import socket
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import usb_kiss_bridge as b  # noqa: E402

FRAME = bytes([b.FEND, 0x00]) + b"\x82\xa0\xa4\xa6@@`\x9e\x8ap\x82\xa0\xa4a\x03\xf0>test" + bytes([b.FEND])


class FakeSerial:
    """The serial side of the bridge; the test drives the other end of the socket pair as the radio."""

    def __init__(self):
        self.ours, self.radio = socket.socketpair()
        self.ours.settimeout(0.2)
        self.fail = False

    def read(self, timeout):
        if self.fail:
            raise ConnectionError("the USB device stopped answering (libusb error -4)")
        try:
            data = self.ours.recv(4096)
        except TimeoutError:
            return b""
        if not data:
            raise ConnectionError("gone")
        return data

    def write(self, data):
        self.ours.sendall(data)

    def close(self):
        self.ours.close()
        self.radio.close()


def start(tx=False, per_min=6, burst=3):
    serial = FakeSerial()
    listen = socket.create_server(("127.0.0.1", 0))
    bridge = b.Bridge(serial, listen, b.TxGate(tx, per_min, burst))
    errors = []

    def run():
        try:
            bridge.run()
        except BaseException as e:  # noqa: BLE001
            errors.append(e)

    t = threading.Thread(target=run, daemon=True)
    t.start()
    client = socket.create_connection(listen.getsockname())
    client.settimeout(1)
    time.sleep(0.2)
    return serial, bridge, client, t, errors


def recv_for(sock, seconds=0.6):
    sock.settimeout(seconds)
    got = b""
    try:
        while True:
            data = sock.recv(4096)
            if not data:
                break
            got += data
    except TimeoutError:
        pass
    return got


class BridgeTest(unittest.TestCase):
    def test_radio_frames_reach_the_client_unchanged(self):
        serial, bridge, client, _, _ = start()
        serial.radio.sendall(FRAME[:10])
        serial.radio.sendall(FRAME[10:])
        self.assertEqual(recv_for(client), FRAME)
        bridge.stop.set()

    def test_receive_only_drops_frames_toward_the_radio(self):
        serial, bridge, client, _, _ = start(tx=False)
        client.sendall(FRAME)
        self.assertEqual(recv_for(serial.radio), b"")
        bridge.stop.set()

    def test_transmit_passes_data_frames_whole(self):
        serial, bridge, client, _, _ = start(tx=True)
        client.sendall(FRAME[:7])
        client.sendall(FRAME[7:])
        self.assertEqual(recv_for(serial.radio), FRAME)
        bridge.stop.set()

    def test_a_second_client_is_refused(self):
        serial, bridge, client, _, _ = start()
        second = socket.create_connection(bridge.listen.getsockname())
        self.assertEqual(recv_for(second), b"")  # closed at once
        serial.radio.sendall(FRAME)
        self.assertEqual(recv_for(client), FRAME)  # the first one keeps working
        bridge.stop.set()

    def test_a_vanished_device_ends_the_bridge_with_its_error(self):
        serial, bridge, client, thread, errors = start()
        serial.fail = True
        thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertTrue(errors and isinstance(errors[0], ConnectionError))


class TxGateTest(unittest.TestCase):
    def test_receive_only_allows_nothing(self):
        self.assertFalse(b.TxGate(False).allow(FRAME[1:-1]))

    def test_the_watchdog_limits_the_frame_rate(self):
        now = [0.0]
        gate = b.TxGate(True, per_min=6, burst=3, clock=lambda: now[0])
        data = FRAME[1:-1]
        self.assertEqual([gate.allow(data) for _ in range(4)], [True, True, True, False])
        now[0] += 10  # one token every 10 s at 6 a minute
        self.assertTrue(gate.allow(data))
        self.assertFalse(gate.allow(data))

    def test_exit_and_oversized_frames_never_pass(self):
        gate = b.TxGate(True)
        self.assertFalse(gate.allow(bytes([0xFF])))
        self.assertFalse(gate.allow(bytes([0x00]) + b"x" * (b.MAX_FRAME + 1)))

    def test_tnc_parameters_pass_without_the_budget(self):
        gate = b.TxGate(True, per_min=6, burst=1)
        self.assertTrue(gate.allow(bytes([0x01, 40])))  # TXDELAY
        self.assertTrue(gate.allow(FRAME[1:-1]))


class DeviceTest(unittest.TestCase):
    def test_a_cdc_acm_function_is_found(self):
        ifaces = [(0, 0x02, 0x02, [(0x83, 0x03)]), (1, 0x0A, 0x00, [(0x81, 0x02), (0x02, 0x02)])]
        self.assertEqual(b.pick_cdc_acm(ifaces), (0, 1, 0x81, 0x02))

    def test_a_vendor_serial_chip_is_refused_by_name(self):
        ftdi = [(0, 0xFF, 0xFF, [(0x81, 0x02), (0x02, 0x02)])]
        self.assertIsNone(b.pick_cdc_acm(ftdi))
        self.assertIn("FTDI", b.not_cdc_acm(0x0403, 0x6001))
        self.assertIn("CH340", b.not_cdc_acm(0x1A86, 0x7523))
        self.assertNotIn("chip", b.not_cdc_acm(0x1234, 0x0001))

    def test_escaped_bytes_are_unescaped(self):
        self.assertEqual(b.unescape(bytes([0x00, b.FESC, b.TFEND, b.FESC, b.TFESC])), bytes([0x00, b.FEND, b.FESC]))

    def test_the_kiss_port_is_loopback_only(self):
        with self.assertRaises(SystemExit):
            b.main(["--serial", "/dev/null", "--host", "0.0.0.0"])


if __name__ == "__main__":
    unittest.main()
