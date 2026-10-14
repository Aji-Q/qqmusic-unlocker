"""Shared MP3 frame validation for browser acceptance."""

def assert_mp3_320k(path):
    """Check actual audio frame rates; ffprobe averages in the short Xing frame."""
    data = path.read_bytes()
    offset = 0
    if data[:3] == b'ID3':
        offset = 10 + sum((data[6 + index] & 127) << (7 * (3 - index)) for index in range(4))
    frame_count = audio_count = 0
    while offset + 4 <= len(data):
        header = int.from_bytes(data[offset:offset + 4], 'big')
        assert header >> 21 == 2047 and (header >> 19) & 3 == 3 and (header >> 17) & 3 == 1, (path, offset, 'invalid MPEG-1 Layer III frame')
        bitrate_index, sample_index = (header >> 12) & 15, (header >> 10) & 3
        assert 0 < bitrate_index < 15 and sample_index < 3, (path, offset)
        bitrate = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320][bitrate_index]
        sample_rate = [44100, 48000, 32000][sample_index]
        length = 144000 * bitrate // sample_rate + ((header >> 9) & 1)
        assert offset + length <= len(data), (path, offset, 'truncated frame')
        xing_offset = offset + (21 if (header >> 6) & 3 == 3 else 36)
        is_xing = frame_count == 0 and data[xing_offset:xing_offset + 4] in [b'Xing', b'Info']
        if not is_xing:
            assert bitrate == 320, (path, offset, bitrate)
            audio_count += 1
        frame_count += 1
        offset += length
    assert offset == len(data) and audio_count > 0, (path, offset, len(data), audio_count)
    return audio_count
