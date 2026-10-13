#!/usr/bin/env python3
"""QQ 音乐加密音频解密引擎（纯标准库，无第三方依赖）。

支持尾部格式：
    musicex —— macOS 客户端 >= 19.57；文件不嵌入 ekey，需本机登录凭据调
               music.vkey.GetEVkey 实时获取
    QTag    —— 旧版 QMC2；ekey 以明文存于尾部
    V1      —— ekey 长度 + 密钥字节存于文件末尾

解密管线：
    ekey -> base64 -> TC-TEA(腾讯 16 轮 CBC 变体) 派生密钥 -> QMC2 流密码
    （key<=300B 走 Map 密码，>300B 走修改版 RC4）

算法实现依据 jixunmoe/tc_tea_rust 与 ownlight6/qmc-decoder。
"""
from __future__ import annotations

import base64
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

IS_WIN = sys.platform.startswith("win")
IS_MAC = sys.platform == "darwin"

HOME = os.path.expanduser("~")
if IS_WIN:
    import wincred  # 同目录；Windows 版凭据读取（只读本人账号文件）
    _APPDATA = os.environ.get("APPDATA", os.path.join(HOME, "AppData", "Roaming"))
    SUPPORT_DIR = os.path.join(_APPDATA, "Tencent", "QQMusic")
    PLIST = wincred.ini_path()          # 仅用于 engine_status 显示路径
    SQLITE = ""                         # Windows 客户端曲库结构不同，标签退回文件名解析
    CACHE_DIR = SUPPORT_DIR
    QQ_PLATFORM = "27"                  # GetEVkey 平台码：20=macOS，27=Windows PC
    QQ_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36")
else:
    PLIST = os.path.join(HOME, "Library/Preferences/com.tencent.QQMusicMac.plist")
    SUPPORT_DIR = os.path.join(
        HOME, "Library/Containers/com.tencent.QQMusicMac/Data/Library/Application Support/QQMusicMac")
    SQLITE = os.path.join(SUPPORT_DIR, "qqmusic.sqlite")
    CACHE_DIR = os.path.join(SUPPORT_DIR, "iQmc")
    QQ_PLATFORM = "20"
    QQ_UA = "QQMusic 19.99.0 (macOS)"
API_URL = "https://u.y.qq.com/cgi-bin/musicu.fcg"
SUPPORTED_EXT = (".mgg", ".mgg1", ".mggl", ".mflac", ".mflac0", ".mflac1",
                 ".qmcogg", ".qmcflac", ".qmc0", ".qmc2", ".qmc3")


def _ffbin(name: str) -> str:
    """定位 ffmpeg / ffprobe：优先打包目录（PyInstaller 把 ffmpeg.exe 放在 exe 旁），
    其次 PATH。返回可执行路径或名字（交给 subprocess 走 PATH）。"""
    exe = name + ".exe" if IS_WIN else name
    roots = []
    if getattr(sys, "frozen", False):          # PyInstaller 运行态
        roots.append(os.path.dirname(sys.executable))
        roots.append(getattr(sys, "_MEIPASS", ""))
    roots.append(os.path.dirname(os.path.abspath(__file__)))
    for root in roots:
        cand = os.path.join(root, exe)
        if root and os.path.isfile(cand):
            return cand
    return shutil.which(name) or name


FFMPEG = _ffbin("ffmpeg")
FFPROBE = _ffbin("ffprobe")

DELTA = 0x9E3779B9
ROUNDS = 16


class EngineError(Exception):
    """带用户可读原因的失败。"""


# --------------------------------------------------------------------- TC-TEA

def _ecb_round(value: int, sum_: int, k1: int, k2: int) -> int:
    left = ((value << 4) & 0xFFFFFFFF) + k1
    right = (value >> 5) + k2
    return (left ^ ((sum_ + value) & 0xFFFFFFFF) ^ right) & 0xFFFFFFFF


def _ecb(block: int, key, encrypt: bool) -> int:
    y, z = (block >> 32) & 0xFFFFFFFF, block & 0xFFFFFFFF
    s = 0 if encrypt else (DELTA * ROUNDS) & 0xFFFFFFFF
    for _ in range(ROUNDS):
        if encrypt:
            s = (s + DELTA) & 0xFFFFFFFF
            y = (y + _ecb_round(z, s, key[0], key[1])) & 0xFFFFFFFF
            z = (z + _ecb_round(y, s, key[2], key[3])) & 0xFFFFFFFF
        else:
            z = (z - _ecb_round(y, s, key[2], key[3])) & 0xFFFFFFFF
            y = (y - _ecb_round(z, s, key[0], key[1])) & 0xFFFFFFFF
            s = (s - DELTA) & 0xFFFFFFFF
    return ((y << 32) | z) & 0xFFFFFFFFFFFFFFFF


def tc_tea_decrypt(data: bytes, key: bytes):
    """腾讯 TEA 变体 CBC 解密；填充或盐校验失败返回 None。"""
    if len(data) % 8 or len(data) < 10:
        return None
    k = list(struct.unpack(">4I", key))
    iv1 = iv2 = 0
    out = bytearray()
    for off in range(0, len(data), 8):
        c = int.from_bytes(data[off:off + 8], "big")
        nxt = _ecb(c ^ iv2, k, False)
        out += (nxt ^ iv1).to_bytes(8, "big")
        iv1, iv2 = c, nxt
    pad = out[0] & 7
    start, end = 1 + pad + 2, len(out) - 7
    if end < start or any(out[end:]):
        return None
    return bytes(out[start:end])


def _simple_make_key(seed: int, size: int):
    return [int(100.0 * abs(math.tan(seed + i * 0.1))) & 0xFF for i in range(size)]


def _derive_tea_key(header: bytes) -> bytes:
    sk = _simple_make_key(106, 8)
    tea = bytearray(16)
    for i in range(0, 16, 2):
        tea[i], tea[i + 1] = sk[i // 2], header[i // 2]
    return bytes(tea)


_ENC_V2_PREFIX = b"QQMusic EncV2,Key:"
_ENC_V2_KEYS = (b"386ZJY!@#*$%^&)(", b"**#!(#$%&^a1cZ,T")


def _b64(data: bytes) -> bytes:
    return base64.b64decode(data + b"=" * (-len(data) % 4))


def parse_ekey(ekey: str) -> bytes:
    """ekey 字符串 -> QMC2 原始密钥。"""
    try:
        decoded = _b64(ekey.strip().strip("\x00").encode())
    except Exception as exc:  # noqa: BLE001
        raise EngineError(f"ekey 不是合法 base64：{exc}") from exc
    if decoded.startswith(_ENC_V2_PREFIX):
        s1 = tc_tea_decrypt(decoded[len(_ENC_V2_PREFIX):], _ENC_V2_KEYS[0])
        s2 = tc_tea_decrypt(s1, _ENC_V2_KEYS[1]) if s1 else None
        if not s2:
            raise EngineError("EncV2 ekey 双层 TC-TEA 解密失败")
        decoded = _b64(s2)
    if len(decoded) < 8:
        raise EngineError(f"ekey 解码后过短（{len(decoded)} 字节）")
    header, body = decoded[:8], decoded[8:]
    if not body:
        return header
    plain = tc_tea_decrypt(body, _derive_tea_key(header))
    return header + plain if plain is not None else decoded


# ------------------------------------------------------------- QMC2 流密码

def _scramble(value: int, index: int) -> int:
    rot = (index + 4) & 7
    v = value & 0xFF
    return v if rot == 0 else (((v << rot) & 0xFF) | (v >> rot))


class _MapCipher:
    def __init__(self, key: bytes):
        self.key, self.n = key, len(key)

    def mask(self, i: int) -> int:
        o = i % 0x7FFF if i > 0x7FFF else i
        idx = (o * o + 71214) % self.n
        return _scramble(self.key[idx], idx)

    def decrypt(self, offset: int, buf: bytearray) -> None:
        for i in range(len(buf)):
            buf[i] ^= self.mask(offset + i)


class _Rc4Cipher:
    FIRST, OTHER = 0x80, 0x1400

    def __init__(self, key: bytes):
        self.key, self.n = key, len(key)
        self.s = [i & 0xFF for i in range(self.n)]
        j = 0
        for i in range(self.n):
            j = (j + self.s[i] + key[i]) % self.n
            self.s[i], self.s[j] = self.s[j], self.s[i]
        self.hash = self._hash(key)

    @staticmethod
    def _hash(data: bytes) -> int:
        h = 1
        for v in data:
            if not v:
                continue
            nxt = (h * v) & 0xFFFFFFFF
            if nxt == 0 or nxt <= h:
                break
            h = nxt
        return h

    def _seg_key(self, sid: int, seed: int) -> int:
        return 0 if not seed else int(self.hash / ((sid + 1) * seed) * 100.0)

    def _first_mask(self, off: int) -> int:
        k1 = self.key[off % self.n]
        return self.key[self._seg_key(off, k1) % self.n]

    def _derive(self, s, j, k):
        n = self.n
        j = (j + 1) % n
        k = (s[j] + k) % n
        s[j], s[k] = s[k], s[j]
        return s[(s[j] + s[k]) % n], j, k

    def _masks(self, offset: int, count: int):
        sid = offset // self.OTHER
        seed = self.key[(sid & 0x1FF) % self.n]
        discard = (self._seg_key(sid, seed) & 0x1FF) + offset % self.OTHER
        s = self.s.copy()
        j = k = 0
        for _ in range(discard):
            _, j, k = self._derive(s, j, k)
        out = []
        for _ in range(count):
            m, j, k = self._derive(s, j, k)
            out.append(m)
        return out

    def decrypt(self, offset: int, buf: bytearray) -> None:
        i, pos, total = 0, offset, len(buf)
        if pos < self.FIRST:
            ln = min(total, self.FIRST - pos)
            for t in range(ln):
                buf[t] ^= self._first_mask(pos + t)
            i, pos = ln, pos + ln
        align = pos % self.OTHER
        while i < total:
            ln = (min(total - i, self.OTHER - align) if align else min(total - i, self.OTHER))
            masks = self._masks(pos, ln)
            for t in range(ln):
                buf[i + t] ^= masks[t]
            i, pos, align = i + ln, pos + ln, 0


def make_cipher(key: bytes):
    return _Rc4Cipher(key) if len(key) > 300 else _MapCipher(key)


# --------------------------------------------------------------- 尾部识别

def detect_footer(data: bytes):
    """返回 (类型, 元数据, 音频数据结束偏移)。"""
    if len(data) >= 16 and data[-8:] == b"musicex\x00":
        size = struct.unpack_from("<I", data, len(data) - 16)[0]
        if 0 < size <= len(data):
            f = data[len(data) - size:]
            return "musicex", {
                "song_id": struct.unpack_from("<I", f, 0)[0],
                "media_mid": f[0x0C:0x0C + 60].decode("utf-16-le", "ignore").rstrip("\x00"),
                "filename": f[0x48:0x48 + 68].decode("utf-16-le", "ignore").rstrip("\x00"),
            }, len(data) - size
    if len(data) >= 8 and data[-4:] == b"QTag":
        off = len(data) - 4
        try:
            size = struct.unpack_from("<I", data, off - 4)[0]
        except struct.error:
            size = 0
        if 0 < size <= off - 4:
            key = data[off - 4 - size:off - 4]
            return "QTag", {"ekey": key.decode("utf-8", "ignore")}, off - 4 - size
    try:
        size = struct.unpack_from("<I", data, len(data) - 4)[0]
    except struct.error:
        size = 0
    if 0 < size < len(data) - 4:
        key = data[len(data) - 4 - size:len(data) - 4]
        if key and all(32 <= c < 127 for c in key[:64]):
            return "V1", {"ekey": key.decode("utf-8", "ignore")}, len(data) - 4 - size
    return "unknown", {}, len(data)


# ----------------------------------------------------------------- 凭据/接口

class Credentials:
    def __init__(self, uin: str, authst: str, login_type: str, ctime: float):
        self.uin, self.authst = uin, authst
        self.login_type, self.ctime = login_type, ctime

    @property
    def masked(self) -> str:
        return self.uin[:3] + "*" * max(len(self.uin) - 5, 3) + self.uin[-2:]


def read_credentials() -> Credentials:
    if IS_WIN:
        uin, authst, login_type = wincred.read_credentials()
        return Credentials(uin, authst, login_type, _plist_mtime())
    if not os.path.exists(PLIST):
        raise EngineError(f"未找到 QQ 音乐凭据文件：{PLIST}（请先在 QQ 音乐登录）")
    import plistlib
    try:
        pl = plistlib.load(open(PLIST, "rb"))
        inner = plistlib.loads(pl["AutoLoginUserInfo"])
        objs = inner["$objects"]
        root = objs[inner["$top"]["root"].data]
        arr = objs[root["userArray"].data]
        user = objs[arr["NS.objects"][0].data]
        return Credentials(str(user["nUserId"]), objs[user["strAuthst"].data],
                           str(user["loginType"]), os.path.getmtime(PLIST))
    except KeyError as exc:
        raise EngineError("凭据文件里没有登录信息，请先登录 QQ 音乐客户端") from exc
    except Exception as exc:  # noqa: BLE001
        raise EngineError(f"读取凭据失败：{exc}") from exc


def fetch_ekey(media_mid: str, filename: str, cred: Credentials, platform: str = QQ_PLATFORM):
    """调用 GetEVkey 取 ekey，返回 (ekey, 过期秒数)。"""
    body = {
        "comm": {"authst": cred.authst, "ct": "19", "cv": "1859",
                 "uin": cred.uin, "tmeLoginType": cred.login_type},
        "req_1": {
            "module": "music.vkey.GetEVkey",
            "method": "CgiGetEVkey",
            "param": {"filename": [filename], "guid": "10000",
                      "songmid": [media_mid], "songtype": [1],
                      "uin": cred.uin, "loginflag": 1,
                      "platform": platform, "ctx": 1},
        },
    }
    req = urllib.request.Request(
        API_URL, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json",
                 "User-Agent": QQ_UA,
                 "Referer": "https://y.qq.com/"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode())
    except Exception as exc:  # noqa: BLE001
        raise EngineError(f"调用 ekey 接口失败：{exc}") from exc
    node = payload.get("req_1", {})
    info = (node.get("data") or {}).get("midurlinfo") or [{}]
    info = info[0]
    if not info.get("ekey"):
        code = info.get("result")
        hint = {104005: "该资源需要 VIP 或 ekey 请求方式不被接受",
                0: "接口返回空 ekey（凭据可能已过期）"}.get(code, "")
        raise EngineError(f"接口未返回 ekey（result={code}）{hint}")
    expire = int((node.get("data") or {}).get("expiration") or 79200)
    return info["ekey"], expire


class EkeyCache:
    """按 (media_mid, filename) 缓存 ekey，凭据变更或过期自动重取。"""

    def __init__(self):
        self._lock = threading.Lock()
        self._items = {}
        self._cred = None

    def _credentials(self) -> Credentials:
        cred = self._cred
        if cred is None or cred.ctime != _plist_mtime():
            cred = read_credentials()
            with self._lock:
                self._cred = cred
                self._items.clear()
        return cred

    def get(self, media_mid: str, filename: str) -> str:
        key = (media_mid, filename)
        with self._lock:
            hit = self._items.get(key)
        if hit and hit[1] > time.time():
            return hit[0]
        cred = self._credentials()
        ekey, expire = fetch_ekey(media_mid, filename, cred)
        with self._lock:
            self._items[key] = (ekey, time.time() + max(expire - 300, 60))
        return ekey

    def invalidate(self):
        with self._lock:
            self._items.clear()
            self._cred = None


def _plist_mtime():
    try:
        return os.path.getmtime(PLIST)
    except OSError:
        return 0.0


# ------------------------------------------------------------------- 曲库标签

def db_lookup(path: str):
    if not SQLITE or not os.path.exists(SQLITE):
        return None
    import sqlite3
    try:
        con = sqlite3.connect(f"file:{SQLITE}?mode=ro", uri=True)
        row = con.execute(
            "SELECT name, singer, album, id FROM SONGS WHERE file LIKE ? LIMIT 1",
            (f"%{os.path.basename(path)}",)).fetchone()
        con.close()
    except sqlite3.Error:
        return None
    if not row:
        return None
    return {"title": row[0], "artist": (row[1] or "").replace("\n", ";"),
            "album": row[2] or "", "song_id": row[3]}


def _parse_name(path: str):
    stem = os.path.splitext(os.path.basename(path))[0]
    if "-" in stem:
        artist, title = stem.split("-", 1)
        return {"artist": artist.strip(), "title": title.strip(), "album": ""}
    return {"artist": "", "title": stem, "album": ""}


def find_cover(song_id) -> str | None:
    """在 QQ 音乐缓存里找内嵌封面图（找不到返回 None）。"""
    if not song_id:
        return None
    for sub in ("iCache", "iDownloadProxy", "iMusic"):
        base = os.path.join(SUPPORT_DIR, sub)
        if not os.path.isdir(base):
            continue
        for root, _, names in os.walk(base):
            for n in names:
                if n.lower().endswith((".jpg", ".jpeg", ".png")) and str(song_id) in n:
                    return os.path.join(root, n)
    return None


# ------------------------------------------------------------------- 转码

def ffprobe(path: str) -> dict:
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-select_streams", "a:0",
         "-show_entries", "stream=codec_name,sample_rate,channels",
         "-show_entries", "format=duration,bit_rate", "-of", "json", path],
        capture_output=True, text=True)
    if out.returncode:
        raise EngineError("ffprobe 无法解析解密结果：" + out.stderr.strip()[:200])
    d = json.loads(out.stdout)
    st = (d.get("streams") or [{}])[0]
    fm = d.get("format", {})
    return {"codec": st.get("codec_name", "?"), "rate": st.get("sample_rate", "?"),
            "channels": st.get("channels", "?"),
            "duration": float(fm.get("duration") or 0),
            "bitrate": int(float(fm.get("bit_rate") or 0))}


def to_mp3(ogg: str, mp3: str, tags: dict, bitrate: str, cover: str | None = None):
    args = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-i", ogg]
    if cover:
        args += ["-i", cover, "-map", "0:a", "-map", "1:v", "-c:v", "mjpeg",
                 "-disposition:v", "attached_pic", "-metadata:s:v",
                 "title=Album cover", "-metadata:s:v", "comment=Cover (front)"]
    else:
        args += ["-map", "0:a"]
    args += ["-map_metadata", "-1", "-c:a", "libmp3lame", "-b:a", bitrate]
    for k in ("title", "artist", "album", "date", "genre"):
        if tags.get(k):
            args += ["-metadata", f"{k}={tags[k]}"]
    if tags.get("track"):
        args += ["-metadata", f"track={tags['track']}"]
    args += ["-metadata", "comment=decrypted from QQMusic encrypted audio",
             "-id3v2_version", "3", "-write_id3v1", "1", mp3]
    proc = subprocess.run(args, capture_output=True, text=True)
    if proc.returncode:
        raise EngineError("ffmpeg 转码失败：" + proc.stderr.strip()[:300])


def decrypt_file(path: str, outdir: str, bitrate: str = "320k",
                 cache: EkeyCache | None = None, progress=None,
                 keep_ogg: bool = False) -> dict:
    """解密单个文件并转 MP3；progress(阶段名, 比例) 回调用于上报进度。"""
    cache = cache or EkeyCache()

    def step(name, ratio):
        if progress:
            progress(name, ratio)

    step("读取文件", 0.02)
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        data = f.read()

    step("识别格式", 0.08)
    kind, meta, audio_end = detect_footer(data)
    body = bytearray(data[:audio_end])
    del data

    step("获取密钥", 0.15)
    if kind == "musicex":
        if not meta.get("media_mid"):
            raise EngineError("musicex 尾部缺少 media_mid，无法获取 ekey")
        ekey = cache.get(meta["media_mid"], meta["filename"])
    elif kind in ("QTag", "V1"):
        ekey = meta.get("ekey", "")
        if not ekey:
            raise EngineError(f"{kind} 尾部未解析出 ekey")
    else:
        raise EngineError("无法识别的尾部格式（既不是 musicex / QTag / V1）")

    step("解密音频流", 0.25)
    make_cipher(parse_ekey(ekey)).decrypt(0, body)
    if bytes(body[:4]) != b"OggS":
        raise EngineError(f"解密失败：输出头不是 OggS（得到 {bytes(body[:4])!r}），"
                          "通常是 ekey 不匹配")

    os.makedirs(outdir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(path))[0]
    tmpdir = tempfile.mkdtemp(prefix="qmdec-")
    ogg = os.path.join(tmpdir, stem + ".ogg")
    try:
        step("写入中间文件", 0.4)
        with open(ogg, "wb") as f:
            f.write(body)
        del body

        step("探测音频参数", 0.5)
        info = ffprobe(ogg)

        step("转码 MP3", 0.6)
        tags = db_lookup(path) or _parse_name(path)
        cover = find_cover(tags.get("song_id"))
        mp3 = os.path.join(outdir, stem + ".mp3")
        to_mp3(ogg, mp3, tags, bitrate, cover)
        if keep_ogg:
            shutil.move(ogg, os.path.join(outdir, stem + ".ogg"))
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    step("完成", 1.0)
    return {"src": path, "footer": kind, "mp3": mp3,
            "size": os.path.getsize(mp3), "src_size": size,
            "codec": info["codec"], "src_bitrate": info["bitrate"],
            "duration": info["duration"], "tags": tags, "cover": bool(cover)}


def scan_folder(folder: str):
    """递归收集目录下受支持的加密音频文件。"""
    found = []
    for root, _, names in os.walk(folder):
        for n in sorted(names):
            if n.lower().endswith(SUPPORTED_EXT) and not n.startswith("."):
                found.append(os.path.join(root, n))
    return found


def engine_status() -> dict:
    """软件启动时自检：ffmpeg / 凭据 / 曲库是否就绪。"""
    st = {"ffmpeg": os.path.isfile(FFMPEG) or bool(shutil.which("ffmpeg")),
          "ffprobe": os.path.isfile(FFPROBE) or bool(shutil.which("ffprobe")),
          "credentials": False, "account": None, "error": None,
          "cache_dir": CACHE_DIR, "cache_exists": os.path.isdir(CACHE_DIR),
          "db": os.path.exists(SQLITE)}
    try:
        cred = read_credentials()
        st["credentials"] = True
        st["account"] = cred.masked
        st["login_type"] = cred.login_type
    except EngineError as exc:
        st["error"] = str(exc)
    if not st["ffmpeg"]:
        st["error"] = ("缺少 ffmpeg" if IS_WIN else "缺少 ffmpeg，请先执行：brew install ffmpeg")
    return st


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="命令行模式（调试用）")
    ap.add_argument("targets", nargs="+")
    ap.add_argument("-o", "--outdir", default=os.path.join(HOME, "Desktop"))
    ap.add_argument("-b", "--bitrate", default="320k")
    ap.add_argument("--keep-ogg", action="store_true")
    a = ap.parse_args()
    files = []
    for t in a.targets:
        files += scan_folder(t) if os.path.isdir(t) else [t]
    eng = EkeyCache()
    for p in files:
        try:
            r = decrypt_file(p, a.outdir, a.bitrate, eng, keep_ogg=a.keep_ogg)
            print(f"[OK] {os.path.basename(p)} -> {r['mp3']} "
                  f"({r['codec']} {r['src_bitrate'] // 1000}k {r['duration']:.1f}s)")
        except EngineError as exc:
            print(f"[FAIL] {os.path.basename(p)}: {exc}")
