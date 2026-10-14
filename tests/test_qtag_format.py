"""QTag wire-format regression: BE tagged lengths, LE V1 lengths.

The format is independently documented by ownlight6/qmc-decoder src/lib.rs:
parse_qtag uses u32::from_be_bytes, whereas V1 uses from_le_bytes.
All audio/key bytes here are synthetic and require no account or network.
"""
import base64
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "app"))
import qmengine as engine


class QTagFormatTests(unittest.TestCase):
    def setUp(self):
        self.key = b"12345678"
        self.ekey = base64.b64encode(self.key)
        self.raw = b"fLaC" + b"synthetic audio" * 20
        self.ciphertext = bytearray(self.raw)
        engine.make_cipher(self.key).decrypt(0, self.ciphertext)

    def test_qtag_big_endian_wire_bytes_and_metadata(self):
        footer = self.ekey + b",123456,2"
        self.assertEqual(len(footer), 21)
        # Literal bytes deliberately avoid generating the regression vector
        # with the parser's own struct endianness convention.
        complete = self.ciphertext + footer + b"\x00\x00\x00\x15QTag"
        kind, meta, audio_end = engine.detect_footer(complete)
        self.assertEqual(kind, "QTag")
        self.assertEqual(meta, {"ekey": self.ekey.decode("ascii")})
        self.assertEqual(audio_end, len(self.raw))
        decoded = bytearray(complete[:audio_end])
        engine.make_cipher(engine.parse_ekey(meta["ekey"])).decrypt(0, decoded)
        self.assertEqual(decoded, self.raw)

    def test_qtag_plain_ekey_uses_big_endian_length(self):
        complete = self.ciphertext + self.ekey + b"\x00\x00\x00\x0cQTag"
        kind, meta, audio_end = engine.detect_footer(complete)
        self.assertEqual((kind, meta["ekey"], audio_end),
                         ("QTag", self.ekey.decode("ascii"), len(self.raw)))

    def test_little_endian_qtag_is_rejected(self):
        complete = self.ciphertext + self.ekey + b"\x0c\x00\x00\x00QTag"
        self.assertEqual(engine.detect_footer(complete), ("unknown", {}, len(complete)))

    def test_v1_keeps_little_endian_length(self):
        complete = self.ciphertext + self.ekey + b"\x0c\x00\x00\x00"
        kind, meta, audio_end = engine.detect_footer(complete)
        self.assertEqual((kind, meta["ekey"], audio_end),
                         ("V1", self.ekey.decode("ascii"), len(self.raw)))
        bad = self.ciphertext + self.ekey + b"\x00\x00\x00\x0c"
        self.assertEqual(engine.detect_footer(bad), ("unknown", {}, len(bad)))

    def test_qtag_invalid_lengths_do_not_fall_back_to_v1(self):
        for length in (0, len(self.raw) + 12, 0xffffffff):
            with self.subTest(length=length):
                complete = self.ciphertext + self.ekey + struct.pack(">I", length) + b"QTag"
                self.assertEqual(engine.detect_footer(complete), ("unknown", {}, len(complete)))

    def test_qtag_decrypt_pipeline_uses_only_ekey_not_metadata(self):
        footer = self.ekey + b",123456,2"
        complete = self.ciphertext + footer + len(footer).to_bytes(4, "big") + b"QTag"
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "qtag.mflac"
            source.write_bytes(complete)

            def convert(source_path, destination, *args):
                self.assertTrue(source_path.endswith(".flac"))
                self.assertEqual(Path(source_path).read_bytes(), self.raw)
                Path(destination).write_bytes(b"synthetic mp3 result")

            with mock.patch.object(engine, "to_mp3", side_effect=convert), \
                 mock.patch.object(engine, "ffprobe", return_value={"codec": "flac", "duration": 1, "bitrate": 1000}), \
                 mock.patch.object(engine, "db_lookup", return_value=None), \
                 mock.patch.object(engine, "find_cover", return_value=None), \
                 mock.patch.object(engine, "fetch_ekey", side_effect=AssertionError("must stay offline")):
                result = engine.decrypt_file(str(source), directory, keep_ogg=True)
            self.assertEqual(result["codec"], "flac")
            self.assertEqual((Path(directory) / "qtag.flac").read_bytes(), self.raw)


if __name__ == "__main__":
    unittest.main()
