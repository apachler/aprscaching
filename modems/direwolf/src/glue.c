// SPDX-License-Identifier: GPL-2.0-or-later
//
// glue.c — a library face on Direwolf's modem for one audio channel: the receive core (demodulator,
// multi-slicer, HDLC, FX.25 and IL2P) and the transmit path (HDLC with bit stuffing, FX.25, IL2P, the tone
// generator), with no audio device, no sockets, no PTT and no threads. The host pushes PCM in and reads
// frames out, or hands a frame in and reads PCM out. One WebAssembly instance holds one receiver or one
// transmitter: Direwolf keeps its state in globals, so the host instantiates the module once per modem.
//
// Receive output buffer, one record per frame the core accepts (FCS-valid, or corrected by FX.25 / IL2P):
//   [u16 length LE][u8 fec: 0 none, 1 FX.25, 2 IL2P][u8 subchan<<4 | slice][u8 corrected bits][AX.25 bytes, no FCS]
//
// Copyright (C) 2026 OE8APR. This file is free software: you can redistribute it and/or modify it under the
// terms of the GNU General Public License as published by the Free Software Foundation, either version 2 of
// the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY; see the GNU
// General Public License for more details.

#include "direwolf.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "audio.h"
#include "ax25_pad.h"
#include "dlq.h"
#include "fx25.h"
#include "gen_tone.h"
#include "hdlc_rec.h"
#include "hdlc_send.h"
#include "il2p.h"
#include "multi_modem.h"
#include "ptt.h"
#include "textcolor.h"

static struct audio_s cfg;

// Fills the channel's modem settings for a speed the way Direwolf's own configuration does: below 600 bd
// the 300-bd HF tones (1600/1800 Hz), from 3600 bd G3RUH scrambled baseband, Bell 202 in between.
static void config_channel(int sample_rate, int baud)
{
	memset(&cfg, 0, sizeof(cfg));
	cfg.adev[0].defined = 1;
	cfg.adev[0].num_channels = 1;
	cfg.adev[0].samples_per_sec = sample_rate;
	cfg.adev[0].bits_per_sample = 16;
	cfg.chan_medium[0] = MEDIUM_RADIO;

	cfg.achan[0].modem_type = MODEM_AFSK;
	cfg.achan[0].mark_freq = DEFAULT_MARK_FREQ;
	cfg.achan[0].space_freq = DEFAULT_SPACE_FREQ;
	cfg.achan[0].baud = baud;
	cfg.achan[0].num_freq = 1;
	cfg.achan[0].offset = 0;
	cfg.achan[0].sanity_test = SANITY_APRS;
	cfg.achan[0].passall = 0;
	strlcpy(cfg.achan[0].profiles, "E+", sizeof(cfg.achan[0].profiles));

	if (baud < 600) {
		cfg.achan[0].mark_freq = 1600;
		cfg.achan[0].space_freq = 1800;
		strlcpy(cfg.achan[0].profiles, "D", sizeof(cfg.achan[0].profiles));
	} else if (baud >= 3600) {
		cfg.achan[0].modem_type = MODEM_SCRAMBLE;
		cfg.achan[0].mark_freq = 0;
		cfg.achan[0].space_freq = 0;
		strlcpy(cfg.achan[0].profiles, " ", sizeof(cfg.achan[0].profiles));
	}
}

// ---------------------------------------------------------------- receive

#define RX_OUT_CAP (64 * 1024)
static unsigned char rx_out[RX_OUT_CAP];
static int rx_out_len = 0;
static int rx_accept_fx25 = 1;
static int rx_accept_il2p = 1;

// profile: a Direwolf demodulator profile ("" keeps the speed's default: E+ at 1200 bd, D at 300 bd).
// fix_bits: 0 passes only FCS-valid frames, as Direwolf's own default does. accept_fx25 / accept_il2p: 0 drops
// frames that arrived in that framing (the core always listens for both).
int dwrx_init(int sample_rate, int baud, const char *profile, int fix_bits, int accept_fx25, int accept_il2p)
{
	config_channel(sample_rate, baud);
	cfg.achan[0].fix_bits = (enum retry_e)fix_bits;
	if (profile && profile[0]) strlcpy(cfg.achan[0].profiles, profile, sizeof(cfg.achan[0].profiles));
	rx_accept_fx25 = accept_fx25;
	rx_accept_il2p = accept_il2p;

	fx25_init(0);
	il2p_init(0);
	multi_modem_init(&cfg);
	rx_out_len = 0;
	return 0;
}

// Feeds n mono 16-bit samples. Returns the number of bytes now waiting in the output buffer.
int dwrx_push(const short *samples, int n)
{
	for (int i = 0; i < n; i++) multi_modem_process_sample(0, samples[i]);
	return rx_out_len;
}

unsigned char *dwrx_out_ptr(void) { return rx_out; }
void dwrx_out_clear(void) { rx_out_len = 0; }
// Data carrier detect: 1 while any slicer of the channel sees an HDLC flag pattern or frame.
int dwrx_dcd(void) { return hdlc_rec_data_detect_any(0); }

// The receive core's frame callback (Direwolf's daemon queues the frame here; the host reads it instead).
void dlq_rec_frame(int chan, int subchan, int slice, packet_t pp, alevel_t alevel, fec_type_t fec_type,
		   retry_t retries, char *spectrum)
{
	(void)chan; (void)alevel; (void)spectrum;
	unsigned char buf[AX25_MAX_PACKET_LEN];
	int n = ax25_pack(pp, buf);
	ax25_delete(pp);
	if ((fec_type == fec_type_fx25 && !rx_accept_fx25) || (fec_type == fec_type_il2p && !rx_accept_il2p)) return;
	if (n <= 0 || rx_out_len + 5 + n > RX_OUT_CAP) return;
	rx_out[rx_out_len++] = n & 0xff;
	rx_out[rx_out_len++] = (n >> 8) & 0xff;
	rx_out[rx_out_len++] = (unsigned char)fec_type;
	rx_out[rx_out_len++] = (unsigned char)(((subchan & 0xf) << 4) | (slice & 0xf));
	rx_out[rx_out_len++] = (unsigned char)(retries < 0 ? 0 : retries > 255 ? 255 : retries);
	memcpy(rx_out + rx_out_len, buf, n);
	rx_out_len += n;
}

// ---------------------------------------------------------------- transmit

static short *tx_out = NULL;
static int tx_out_len = 0;
static int tx_out_cap = 0;
static int tx_byte_lo = 0;
static int tx_byte_half = 0;

// mode: 0 AX.25, 1 FX.25, 2 IL2P. fx25_check_bytes: 16, 32 or 64 (Direwolf's FX25TX strength; a frame too long
// for that code falls back to plain AX.25, as in Direwolf). il2p_max_fec: 1 for the maximum FEC, 0 for the
// size-based choice. amplitude: peak level in percent of full scale.
int dwtx_init(int sample_rate, int baud, int mode, int fx25_check_bytes, int il2p_max_fec, int amplitude)
{
	config_channel(sample_rate, baud);
	cfg.achan[0].layer2_xmit = mode == 1 ? LAYER2_FX25 : mode == 2 ? LAYER2_IL2P : LAYER2_AX25;
	cfg.achan[0].fx25_strength = fx25_check_bytes;
	cfg.achan[0].il2p_max_fec = il2p_max_fec;
	cfg.achan[0].il2p_invert_polarity = 0;
	fx25_init(0);
	il2p_init(0);
	gen_tone_init(&cfg, amplitude, 0);
	tx_out_len = 0;
	tx_byte_half = 0;
	return 0;
}

// The tone generator's audio sink: little-endian 16-bit bytes, collected into samples in memory.
int audio_put(int a, int c)
{
	(void)a;
	if (!tx_byte_half) {
		tx_byte_lo = c & 0xff;
		tx_byte_half = 1;
		return c;
	}
	tx_byte_half = 0;
	if (tx_out_len == tx_out_cap) {
		int cap = tx_out_cap ? tx_out_cap * 2 : 65536;
		short *grown = realloc(tx_out, (size_t)cap * sizeof(short));
		if (!grown) return -1;
		tx_out = grown;
		tx_out_cap = cap;
	}
	tx_out[tx_out_len++] = (short)(tx_byte_lo | ((c & 0xff) << 8));
	return c;
}

int audio_flush(int a) { (void)a; return 0; }

// Modulates one frame (AX.25 bytes without FCS; the FCS is computed here) behind txdelay_ms of preamble
// (HDLC flags, or the IL2P preamble pattern) and followed by txtail_ms of the same. Returns the number of
// samples, or -1 when the bytes are not an AX.25 frame. The samples stay valid until the next call.
int dwtx_modulate(const unsigned char *frame, int len, int txdelay_ms, int txtail_ms)
{
	tx_out_len = 0;
	tx_byte_half = 0;
	alevel_t alevel;
	memset(&alevel, 0, sizeof(alevel));
	packet_t pp = ax25_from_frame((unsigned char *)frame, len, alevel);
	if (pp == NULL) return -1;
	int bits_per_sec = cfg.achan[0].baud;
	layer2_preamble_postamble(0, (txdelay_ms * bits_per_sec / 1000) / 8, 0, &cfg);
	layer2_send_frame(0, pp, 0, &cfg);
	layer2_preamble_postamble(0, (txtail_ms * bits_per_sec / 1000) / 8, 1, &cfg);
	ax25_delete(pp);
	return tx_out_len;
}

short *dwtx_out_ptr(void) { return tx_out; }

// ---------------------------------------------------------------- shared

// Input scratch buffer the host writes into (PCM for receive, a frame for transmit).
static short inbuf[16384];
short *dw_in_ptr(void) { return inbuf; }
int dw_in_cap(void) { return (int)(sizeof(inbuf) / sizeof(inbuf[0])); }

// Direwolf's console output is for its daemon; a library stays silent.
void text_color_set(dw_color_t c) { (void)c; }
int dw_printf(const char *fmt, ...) { (void)fmt; return 0; }

// The DCD and PTT outputs: the receive core reports carrier changes here, and the host drives PTT itself.
void ptt_set(int ot, int chan, int ptt_signal) { (void)ot; (void)chan; (void)ptt_signal; }
int get_input(int it, int chan) { (void)it; (void)chan; return -1; }
// demod_get_sample reads from an audio device; the host pushes samples instead.
int audio_get(int a) { (void)a; return -1; }
// AIS is not an APRS mode; the receiver is never configured for it, so these are never reached.
void ais_to_nmea(unsigned char *ais, int ais_len, char *nema, int nema_size)
{ (void)ais; (void)ais_len; if (nema_size > 0) nema[0] = 0; }
int ais_check_length(int type, int length) { (void)type; (void)length; return -1; }

#ifdef DW_MAIN
// Native driver for cross-checks: `glue rx file.wav [baud]` prints one hex line per frame; `glue tx baud mode
// rate hex…` writes raw 16-bit PCM of the frames to stdout.
int main(int argc, char **argv)
{
	if (argc > 2 && strcmp(argv[1], "rx") == 0) {
		FILE *fp = fopen(argv[2], "rb");
		if (!fp) { perror(argv[2]); return 1; }
		unsigned char hdr[44];
		if (fread(hdr, 1, 44, fp) != 44) return 1;
		int rate = hdr[24] | hdr[25] << 8 | hdr[26] << 16 | hdr[27] << 24;
		dwrx_init(rate, argc > 3 ? atoi(argv[3]) : 1200, "", 0, 1, 1);
		short buf[4096];
		size_t n;
		while ((n = fread(buf, 2, 4096, fp)) > 0) {
			dwrx_push(buf, (int)n);
			for (int p = 0; p < rx_out_len;) {
				int len = rx_out[p] | rx_out[p + 1] << 8;
				printf("F %d ", rx_out[p + 2]);
				for (int i = 0; i < len; i++) printf("%02x", rx_out[p + 5 + i]);
				printf("\n");
				p += 5 + len;
			}
			rx_out_len = 0;
		}
		return 0;
	}
	if (argc > 5 && strcmp(argv[1], "tx") == 0) {
		dwtx_init(atoi(argv[4]), atoi(argv[2]), atoi(argv[3]), 16, 1, 50);
		for (int f = 5; f < argc; f++) {
			unsigned char fr[AX25_MAX_PACKET_LEN];
			int len = (int)strlen(argv[f]) / 2;
			for (int i = 0; i < len; i++) sscanf(argv[f] + 2 * i, "%2hhx", &fr[i]);
			int n = dwtx_modulate(fr, len, 300, 50);
			if (n > 0) fwrite(tx_out, 2, n, stdout);
		}
		return 0;
	}
	fprintf(stderr, "usage: glue rx file.wav [baud] | glue tx baud mode rate hex...\n");
	return 2;
}
#endif
