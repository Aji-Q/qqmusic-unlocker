/* Strict packet-completeness validator for a supported Xiph VBR profile.
 * This is stronger than general Vorbis validity: legal truncated or padded
 * packets outside this profile are deliberately rejected. No PCM is returned.
 */
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <ogg/ogg.h>
#include <vorbis/codec.h>
#include "codec_internal.h"
#define MAX_HEADER 65536
#define MAX_PACKET 131072
#define CONTEXT_MAGIC 0x51564f52u

typedef struct {
  uint32_t magic;
  vorbis_info vi;
  vorbis_comment vc;
  vorbis_dsp_state vd;
  vorbis_block vb;
  int headers, dsp_ready, block_ready, failed, incomplete;
  long consumed, remaining;
} qqv_context;

/* Invoked only by explicit floor/residue failure branches in strict-eop.patch.
 * A look-ahead miss alone is not an error: the decoder may retry fewer bits. */
void qqv_incomplete(vorbis_block *vb) {
  qqv_context *c = (qqv_context *)((char *)vb - offsetof(qqv_context, vb));
  c->incomplete = 1;
}

qqv_context *qqv_create(void) {
  qqv_context *c = calloc(1, sizeof(*c));
  if (!c) return NULL;
  c->magic = CONTEXT_MAGIC;
  vorbis_info_init(&c->vi);
  vorbis_comment_init(&c->vc);
  return c;
}

int qqv_header(qqv_context *c, unsigned char *data, int length) {
  if (!c || c->magic != CONTEXT_MAGIC || !data || length < 1 || length > MAX_HEADER || c->headers >= 3 || c->failed) return -1;
  ogg_packet packet = {0};
  packet.packet = data; packet.bytes = length;
  packet.b_o_s = c->headers == 0; packet.packetno = c->headers;
  if (vorbis_synthesis_headerin(&c->vi, &c->vc, &packet)) { c->failed = 1; return -2; }
  c->headers++;
  if (c->headers == 1) {
    if (c->vi.channels != 2) { c->failed = 1; return -20; }
    if (c->vi.bitrate_upper != 0 || c->vi.bitrate_lower != 0) { c->failed = 1; return -21; }
  }
  if (c->headers == 3) {
    codec_setup_info *ci = c->vi.codec_setup;
    if (!ci || ci->modes != 2 || !ci->mode_param[0] || !ci->mode_param[1] ||
        ci->mode_param[0]->blockflag != 0 || ci->mode_param[1]->blockflag != 1) {
      c->failed = 1; return -22;
    }
    if (vorbis_synthesis_init(&c->vd, &c->vi)) { c->failed = 1; return -23; }
    c->dsp_ready = 1;
    if (vorbis_block_init(&c->vd, &c->vb)) { c->failed = 1; return -24; }
    c->block_ready = 1;
  }
  return 0;
}

int qqv_ready(qqv_context *c) {
  return c && c->magic == CONTEXT_MAGIC && c->headers == 3 && c->block_ready && !c->failed;
}

int qqv_packet(qqv_context *c, unsigned char *data, int length) {
  if (!qqv_ready(c) || !data || length < 1 || length > MAX_PACKET) return -1;
  ogg_packet packet = {0}; packet.packet = data; packet.bytes = length;
  c->consumed = c->remaining = -1;
  c->incomplete = 0;
  if (vorbis_synthesis(&c->vb, &packet)) return -6;
  c->consumed = oggpack_bits(&c->vb.opb);
  c->remaining = (long)length * 8 - c->consumed;
  if (c->incomplete) return -10;
  if (c->consumed < 0 || c->remaining < 0) return -7;
  if (c->remaining > 7) return -9;
  for (long bit = c->consumed; bit < (long)length * 8; bit++)
    if ((data[bit >> 3] >> (bit & 7)) & 1) return -8;
  return 0;
}

int qqv_consumed(qqv_context *c) { return c && c->magic == CONTEXT_MAGIC ? c->consumed : -1; }
int qqv_remaining(qqv_context *c) { return c && c->magic == CONTEXT_MAGIC ? c->remaining : -1; }
void qqv_destroy(qqv_context *c) {
  if (!c || c->magic != CONTEXT_MAGIC) return;
  if (c->block_ready) vorbis_block_clear(&c->vb);
  if (c->dsp_ready) vorbis_dsp_clear(&c->vd);
  vorbis_comment_clear(&c->vc); vorbis_info_clear(&c->vi);
  c->magic = 0; free(c);
}
