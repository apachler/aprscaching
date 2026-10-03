// SPDX-License-Identifier: AGPL-3.0-or-later
// axkit — the kernel-side probes for the KISS TCP vs kernel AX.25 interop leg.
//
//   axkit tap <tty> <log>                        log every KISS frame on a kissnetd pty, still escaped
//   axkit mon <iface> <log>                      log every frame the kernel sends or receives on <iface>
//   axkit ui <portcall> <src> <dst> <hex> [n]    send n UI frames through the kernel stack (AF_AX25)
//
// A log line is "<tag> <hex>": the tap writes "kiss", the monitor "in" or "out". The tap keeps a frame's
// bytes exactly as they crossed the wire (type byte, FESC sequences), so the test can assert the
// encoding; the monitor shows the frame as the kernel decoded it, behind its one-byte KISS header.
#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/ax25.h>
#include <linux/if_ether.h>
#include <linux/if_packet.h>
#include <net/if.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <termios.h>
#include <unistd.h>

static _Noreturn void die(const char *what) {
  perror(what);
  exit(1);
}

static void hexline(FILE *f, const char *tag, const unsigned char *b, size_t n) {
  fprintf(f, "%s ", tag);
  for (size_t i = 0; i < n; i++) fprintf(f, "%02x", b[i]);
  fputc('\n', f);
  fflush(f);
}

// "OE9KRN-1" → the kernel's shifted 7-byte address
static void aton(const char *s, ax25_address *a) {
  int i = 0;
  memset(a->ax25_call, ' ' << 1, 6);
  for (; *s && *s != '-' && i < 6; s++, i++) a->ax25_call[i] = (char)(toupper((unsigned char)*s) << 1);
  int ssid = (*s == '-') ? atoi(s + 1) : 0;
  a->ax25_call[6] = (char)((ssid << 1) & 0x1e);
}

static int tap(const char *tty, const char *log) {
  int fd = open(tty, O_RDWR | O_NOCTTY);
  if (fd < 0) die("open tty");
  struct termios t;
  if (tcgetattr(fd, &t) == 0) {
    cfmakeraw(&t);
    tcsetattr(fd, TCSANOW, &t);
  }
  FILE *f = fopen(log, "a");
  if (!f) die("open log");
  unsigned char frame[4096], buf[4096];
  size_t n = 0;
  int open_frame = 0;
  for (;;) {
    ssize_t r = read(fd, buf, sizeof buf);
    if (r < 0 && errno == EINTR) continue;
    if (r <= 0) die("read tty");
    for (ssize_t i = 0; i < r; i++) {
      if (buf[i] == 0xc0) {
        if (open_frame && n > 0) hexline(f, "kiss", frame, n);
        open_frame = 1;
        n = 0;
      } else if (open_frame && n < sizeof frame) {
        frame[n++] = buf[i];
      }
    }
  }
}

static int mon(const char *iface, const char *log) {
  int s = socket(AF_PACKET, SOCK_RAW, htons(ETH_P_ALL));
  if (s < 0) die("socket AF_PACKET");
  struct sockaddr_ll sll = {0};
  sll.sll_family = AF_PACKET;
  sll.sll_protocol = htons(ETH_P_ALL);
  sll.sll_ifindex = (int)if_nametoindex(iface);
  if (!sll.sll_ifindex) die("if_nametoindex");
  if (bind(s, (struct sockaddr *)&sll, sizeof sll) < 0) die("bind AF_PACKET");
  FILE *f = fopen(log, "a");
  if (!f) die("open log");
  unsigned char buf[4096];
  for (;;) {
    struct sockaddr_ll from;
    socklen_t fl = sizeof from;
    ssize_t r = recvfrom(s, buf, sizeof buf, 0, (struct sockaddr *)&from, &fl);
    if (r < 0 && errno == EINTR) continue;
    if (r < 0) die("recvfrom");
    hexline(f, from.sll_pkttype == PACKET_OUTGOING ? "out" : "in", buf, (size_t)r);
  }
}

static int unhex(const char *h, unsigned char *out, size_t max) {
  size_t n = strlen(h) / 2;
  if (n > max) n = max;
  for (size_t i = 0; i < n; i++) {
    unsigned v;
    if (sscanf(h + 2 * i, "%2x", &v) != 1) return -1;
    out[i] = (unsigned char)v;
  }
  return (int)n;
}

static int ui(const char *portcall, const char *src, const char *dst, const char *hex, int count) {
  int s = socket(AF_AX25, SOCK_DGRAM, 0);
  if (s < 0) die("socket AF_AX25");
  struct full_sockaddr_ax25 me = {0};
  me.fsa_ax25.sax25_family = AF_AX25;
  me.fsa_ax25.sax25_ndigis = 1;
  aton(src, &me.fsa_ax25.sax25_call);
  aton(portcall, &me.fsa_digipeater[0]); // the port to send on, named by its callsign
  if (bind(s, (struct sockaddr *)&me, sizeof me) < 0) die("bind AF_AX25");
  struct sockaddr_ax25 to = {0};
  to.sax25_family = AF_AX25;
  aton(dst, &to.sax25_call);
  unsigned char payload[512];
  int n = unhex(hex, payload, sizeof payload - 8);
  if (n < 0) die("hex");
  for (int i = 0; i < count; i++) {
    int len = n;
    if (count > 1) len += snprintf((char *)payload + n, 8, "#%02d", i); // a burst numbers each frame
    if (sendto(s, payload, (size_t)len, 0, (struct sockaddr *)&to, sizeof to) < 0) die("sendto");
  }
  close(s);
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 4 && !strcmp(argv[1], "tap")) return tap(argv[2], argv[3]);
  if (argc == 4 && !strcmp(argv[1], "mon")) return mon(argv[2], argv[3]);
  if ((argc == 6 || argc == 7) && !strcmp(argv[1], "ui"))
    return ui(argv[2], argv[3], argv[4], argv[5], argc == 7 ? atoi(argv[6]) : 1);
  fprintf(stderr, "usage: axkit tap <tty> <log> | mon <iface> <log> | ui <portcall> <src> <dst> <hex> [n]\n");
  return 2;
}
