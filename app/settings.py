"""应用偏好；只保存输出选项，不保存 QQ 音乐账号或密钥。"""
from __future__ import annotations

import json
import os
import sys
import tempfile

BITRATES = ("128k", "192k", "256k", "320k")
FIELDS = ("outdir", "bitrate", "keep_ogg")


class SettingsError(ValueError):
    pass


def default_path() -> str:
    override = os.environ.get("QQMUSIC_UNLOCKER_CONFIG_DIR")
    if override:
        return os.path.join(os.path.abspath(os.path.expanduser(override)), "settings.json")
    home = os.path.expanduser("~")
    if sys.platform.startswith("win"):
        root = os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local")
    elif sys.platform == "darwin":
        root = os.path.join(home, "Library", "Application Support")
    else:
        root = os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
    return os.path.join(root, "QQMusicUnlocker", "settings.json")


def validate(values: dict) -> dict:
    """校验完整设置。创建输出目录留到开始任务，避免保存偏好时产生文件。"""
    outdir = values.get("outdir")
    if not isinstance(outdir, str) or not outdir.strip() or "\x00" in outdir:
        raise SettingsError("请选择有效的输出文件夹")
    outdir = os.path.expanduser(outdir)
    if not os.path.isabs(outdir):
        raise SettingsError("输出目录必须是完整路径，请重新选择文件夹")
    bitrate = values.get("bitrate")
    if bitrate not in BITRATES:
        raise SettingsError("请选择 128、192、256 或 320 kbps")
    keep_ogg = values.get("keep_ogg")
    if not isinstance(keep_ogg, bool):
        raise SettingsError("保留原格式选项必须为开或关")
    return {"outdir": os.path.normpath(outdir), "bitrate": bitrate,
            "keep_ogg": keep_ogg}


def load(defaults: dict, path: str | None = None) -> tuple[dict, str | None]:
    """缺少、损坏或旧版本未知字段不会阻止启动。"""
    path = path or default_path()
    try:
        with open(path, encoding="utf-8") as handle:
            saved = json.load(handle)
        if not isinstance(saved, dict):
            raise SettingsError("invalid settings")
        values = {**defaults, **{key: saved[key] for key in FIELDS if key in saved}}
        return validate(values), None
    except FileNotFoundError:
        return defaults.copy(), None
    except (OSError, ValueError, TypeError):
        return defaults.copy(), "已恢复默认设置，请确认输出目录"


def save(values: dict, path: str | None = None) -> None:
    """同目录临时文件 + 原子替换；失败时保留上一份完整设置。"""
    values = validate(values)
    path = path or default_path()
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, mode=0o700, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".settings-", suffix=".json", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump({"version": 1, **values}, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
