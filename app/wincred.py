"""Windows 版登录凭据读取：只读本机当前用户自己的 QQ 音乐配置文件。

和 macOS 版读 ~/Library/.../com.tencent.QQMusicMac.plist 完全同构——换成读
%APPDATA%\\Tencent\\QQMusic 下本人账号的文件：

    uin    ←  QQMusicServiceConfig.ini 里的 `Uin=`
    authst ←  SetCookie.dat / _SetCookie.dat 里的 `"authst":"..."`

本文件只做文件读取与文本解析，不写文件、不碰别的进程、不改 QQ 音乐客户端、
不发网络请求。两个解析函数是纯函数，任何平台都能单测。

来源：ownlight6/qmc-decoder、skxxxkx666/kugo-music-converter 的 Windows 文件读取分支
（两者的进程内存兜底未采用）。
"""
from __future__ import annotations

import os
import re

# "authst":"<token>"（base64/base64url，至少 16 字符）。QQ 音乐把它明文存在 cookie 文件里。
_AUTHST = re.compile(rb'"authst"\s*:\s*"([A-Za-z0-9+/=_-]{16,4096})"')


def qqmusic_dir() -> str:
    base = os.environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Roaming")
    return os.path.join(base, "Tencent", "QQMusic")


def ini_path() -> str:
    return os.path.join(qqmusic_dir(), "QQMusicServiceConfig.ini")


def cookie_paths() -> list[str]:
    return [os.path.join(qqmusic_dir(), n) for n in ("SetCookie.dat", "_SetCookie.dat")]


def _decode(raw: bytes) -> str:
    """ini 可能是 UTF-16LE（带 BOM）或 UTF-8/GBK。"""
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return raw.decode("utf-16", "ignore")
    for enc in ("utf-8-sig", "gbk"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", "ignore")


def parse_uin(text: str) -> str | None:
    """'Uin=12345' -> '12345'；缺失或为 0 返回 None。

    >>> parse_uin("[Config]\\nUin=10086\\n")
    '10086'
    >>> parse_uin("uin=0") is None
    True
    """
    for line in text.splitlines():
        key, sep, val = line.partition("=")
        if sep and key.strip().lower() == "uin":
            v = val.strip()
            if v.isascii() and v.isdigit() and int(v) > 0:
                return v
    return None


def authst_from_blob(data: bytes) -> str | None:
    """从 cookie 文件原始字节里取 authst，取最长的一个匹配。

    >>> authst_from_blob(b'...{"authst":"AbCd1234==longertoken___"}...')
    'AbCd1234==longertoken___'
    """
    best = None
    for m in _AUTHST.finditer(data):
        tok = m.group(1).decode("ascii", "ignore")
        if best is None or len(tok) > len(best):
            best = tok
    return best


def read_uin() -> str:
    path = ini_path()
    if not os.path.exists(path):
        raise FileNotFoundError(
            f"未找到 QQ 音乐配置：{path}（请先安装并登录 QQ 音乐客户端）")
    with open(path, "rb") as handle:
        uin = parse_uin(_decode(handle.read()))
    if not uin:
        raise ValueError("配置文件里没有 Uin，请先在 QQ 音乐客户端登录")
    return uin


def read_authst() -> str:
    tried = []
    for path in cookie_paths():
        tried.append(path)
        if not os.path.exists(path):
            continue
        with open(path, "rb") as handle:
            tok = authst_from_blob(handle.read())
        if tok:
            return tok
    raise ValueError(
        "cookie 文件里没找到 authst（登录态可能已失效，请在 QQ 音乐客户端重新登录）。"
        f"\n已查找：{', '.join(tried)}")


def read_credentials():
    """返回 (uin, authst, login_type)。失败抛异常，消息可直接给用户看。"""
    return read_uin(), read_authst(), "3"
