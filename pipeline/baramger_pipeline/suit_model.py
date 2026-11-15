"""The crew figure: NASA's Z2 Spacesuit 3D model (NASA 3D Resources, extra source S9).

The app's copy differs from NASA's file in three ways, and in nothing else (same mesh, same material):
1. NASA's file (16.9 MB) keeps every picture twice: as WebP and as a JPEG fallback for programs
   that cannot read WebP (glTF extension EXT_texture_webp). The app's map engine (CesiumJS) reads
   WebP, so the copy leaves the JPEG fallbacks out.
2. NASA's colour picture has grime painted on the white fabric (soft dark and brown patches, as
   on a suit used in field tests). The user asked for clean suits, so `clean_suit_colours` takes
   the soft patches off the white fabric. It keeps the seams and stitching (thin dark lines), the
   black parts (visor, gloves, bearings), the red stripes, blue bands, flag and patches.
3. NASA's material names a bump picture with strength 0 ("off"). CesiumJS drew it anyway, which
   put grey speckles in the old grime pattern on the suit. The copy leaves that unused picture out.

    uv run python -I -m baramger_pipeline.suit_model <NASA .glb> <app copy .glb>
"""

from __future__ import annotations

import hashlib
import io
import json
import struct
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as ndi

GLB_MAGIC = 0x46546C67  # "glTF"
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942
WEBP = "EXT_texture_webp"


def read_glb(data: bytes) -> tuple[dict, bytes]:
    magic, version, length = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC or version != 2 or length != len(data):
        raise ValueError("not a glTF 2.0 binary file")
    jlen, jtype = struct.unpack_from("<II", data, 12)
    if jtype != CHUNK_JSON:
        raise ValueError("the first chunk is not JSON")
    gltf = json.loads(data[20 : 20 + jlen])
    off = 20 + jlen
    binary = b""
    if off < len(data):
        blen, btype = struct.unpack_from("<II", data, off)
        if btype != CHUNK_BIN:
            raise ValueError("the second chunk is not BIN")
        binary = data[off + 8 : off + 8 + blen]
    return gltf, binary


def write_glb(gltf: dict, binary: bytes) -> bytes:
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    binary += b"\0" * (-len(binary) % 4)
    total = 12 + 8 + len(js) + (8 + len(binary) if binary else 0)
    out = struct.pack("<III", GLB_MAGIC, 2, total) + struct.pack("<II", len(js), CHUNK_JSON) + js
    if binary:
        out += struct.pack("<II", len(binary), CHUNK_BIN) + binary
    return out


def _buffer_view_refs(gltf: dict):
    """Every place that names a bufferView, as (container, key) pairs."""
    for acc in gltf.get("accessors", []):
        if "bufferView" in acc:
            yield acc, "bufferView"
        sparse = acc.get("sparse")
        if sparse:
            yield sparse["indices"], "bufferView"
            yield sparse["values"], "bufferView"
    for img in gltf.get("images", []):
        if "bufferView" in img:
            yield img, "bufferView"
    for mesh in gltf.get("meshes", []):
        for prim in mesh.get("primitives", []):
            draco = prim.get("extensions", {}).get("KHR_draco_mesh_compression")
            if draco and "bufferView" in draco:
                yield draco, "bufferView"


def drop_texture_fallbacks(gltf: dict, binary: bytes) -> tuple[dict, bytes]:
    """Remove the fallback pictures of textures that have a WebP version, and the bytes they use."""
    gltf = json.loads(json.dumps(gltf))  # work on a copy
    textures = gltf.get("textures", [])
    images = gltf.get("images", [])
    webp_used = {t["extensions"][WEBP]["source"] for t in textures if WEBP in t.get("extensions", {})}
    plain_used = {t["source"] for t in textures if "source" in t and WEBP not in t.get("extensions", {})}
    fallback = {t["source"] for t in textures if "source" in t and WEBP in t.get("extensions", {})}
    drop = fallback - webp_used - plain_used
    if not drop:
        return gltf, binary
    for t in textures:
        if WEBP in t.get("extensions", {}):
            t.pop("source", None)  # allowed once EXT_texture_webp is required
    keep_images = [i for i in range(len(images)) if i not in drop]
    image_map = {old: new for new, old in enumerate(keep_images)}
    for t in textures:
        ext = t.get("extensions", {}).get(WEBP)
        if ext:
            ext["source"] = image_map[ext["source"]]
        if "source" in t:
            t["source"] = image_map[t["source"]]
    dropped_views = {images[i]["bufferView"] for i in drop if "bufferView" in images[i]}
    gltf["images"] = [images[i] for i in keep_images]
    # the bufferViews still named somewhere stay; their bytes are packed again in the same order
    used = {holder[key] for holder, key in _buffer_view_refs(gltf)}
    views = gltf.get("bufferViews", [])
    if used & dropped_views:
        raise ValueError("a dropped picture shares its bytes with something that stays")
    keep_views = [i for i in range(len(views)) if i not in dropped_views]
    view_map = {old: new for new, old in enumerate(keep_views)}
    packed = bytearray()
    new_views = []
    for i in keep_views:
        v = dict(views[i])
        start = v.get("byteOffset", 0)
        chunk = binary[start : start + v["byteLength"]]
        packed += b"\0" * (-len(packed) % 4)  # every view starts on a 4-byte boundary
        v["byteOffset"] = len(packed)
        packed += chunk
        new_views.append(v)
    for holder, key in _buffer_view_refs(gltf):
        holder[key] = view_map[holder[key]]
    gltf["bufferViews"] = new_views
    gltf["buffers"][0]["byteLength"] = len(packed)
    for name in ("extensionsUsed", "extensionsRequired"):
        if WEBP not in gltf.setdefault(name, []):
            gltf[name].append(WEBP)
    return gltf, bytes(packed)


FABRIC_WHITE = 0.87  # the clean fabric's brightness (NASA's cleanest fabric is about 0.85-0.9)
FABRIC_TINT = (0.985, 0.98, 0.965)  # a slightly warm white, like the suit's own fabric
SEAM_MIN_PX = 20  # a kept dark line is at least this long
SOLID_MIN_PX = 40  # a kept black part is at least this big


def clean_suit_colours(rgb: np.ndarray) -> np.ndarray:
    """Take the painted grime off the white fabric of a suit picture (H x W x 3, values 0-1).

    - Background (pure white), coloured parts (strong red or blue, the flag and patches) stay.
    - Dark parts that are nearly all deep black (visor, gloves, bearings) stay.
    - The rest is fabric: it becomes an even white. Dark lines thinner than 9 px and at least
      SEAM_MIN_PX long (seams, stitching) are kept. Grime is soft and wide, brown-grey, or small
      dark dots, so it goes.
    """
    a = rgb.astype(np.float32)
    lum = a @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mx, mn = a.max(2), a.min(2)
    d = np.maximum(mx - mn, 1e-6)
    sat = np.where(mx > 0.02, (mx - mn) / np.maximum(mx, 1e-6), 0)
    hue = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60
    background = mn >= 0.985
    brownish = (hue >= 12) & (hue <= 60) & (lum < 0.6) & (sat > 0.12)
    colour = (sat > 0.35) & (lum > 0.12) & ~brownish
    dark = (lum < 0.35) & ~background & ~colour
    labels, n = ndi.label(dark, structure=np.ones((3, 3)))
    ids = np.arange(1, n + 1)
    if n:
        size = np.asarray(ndi.sum(np.ones_like(lum), labels, ids))
        deep = np.asarray(ndi.mean((lum < 0.12).astype(np.float32), labels, ids))
        solid = np.isin(labels, ids[(deep > 0.7) & (size >= SOLID_MIN_PX)])
    else:
        solid = np.zeros_like(dark)
    fabric = ~background & ~colour & ~solid
    lines = lum - ndi.grey_closing(lum, size=(9, 9))  # <= 0: only dark features thinner than 9 px
    marks = lines < -0.05
    found, k = ndi.label(marks, structure=np.ones((3, 3)))
    if k:
        boxes = ndi.find_objects(found)
        long_ids = [i + 1 for i, b in enumerate(boxes) if b and max(b[0].stop - b[0].start, b[1].stop - b[1].start) >= SEAM_MIN_PX]
        marks = np.isin(found, long_ids)  # a seam is long; a grime dot is not
    lines = np.where(marks, lines, 0) * 0.85
    clean = np.clip(FABRIC_WHITE + lines, 0, 1)[..., None] * np.array(FABRIC_TINT, np.float32)
    blend = ndi.gaussian_filter(fabric.astype(np.float32), 1.2)[..., None]  # soft edges between parts
    return np.clip(a * (1 - blend) + clean * blend, 0, 1)


def base_colour_image(gltf: dict) -> int:
    """The index of the picture that gives the (first) material its colours."""
    tex = gltf["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"]["index"]
    t = gltf["textures"][tex]
    return t.get("extensions", {}).get(WEBP, {}).get("source", t.get("source"))


def replace_image(gltf: dict, binary: bytes, image: int, data: bytes, mime: str) -> tuple[dict, bytes]:
    """Put new bytes in place of one embedded picture; every other byte keeps its order."""
    gltf = json.loads(json.dumps(gltf))
    target = gltf["images"][image]["bufferView"]
    packed = bytearray()
    for i, v in enumerate(gltf["bufferViews"]):
        start = v.get("byteOffset", 0)
        chunk = data if i == target else binary[start : start + v["byteLength"]]
        packed += b"\0" * (-len(packed) % 4)
        v["byteOffset"] = len(packed)
        v["byteLength"] = len(chunk)
        packed += chunk
    gltf["images"][image]["mimeType"] = mime
    gltf["buffers"][0]["byteLength"] = len(packed)
    return gltf, bytes(packed)


def _texture_refs(node, out: list) -> None:
    """Every {"index": n} that names a texture inside a material (any "...Texture" key)."""
    if isinstance(node, dict):
        for k, v in node.items():
            if k.endswith("Texture") and isinstance(v, dict) and "index" in v:
                out.append(v)
            _texture_refs(v, out)
    elif isinstance(node, list):
        for v in node:
            _texture_refs(v, out)


def drop_switched_off_normal_maps(gltf: dict, binary: bytes) -> tuple[dict, bytes]:
    """Remove normal maps with strength 0, then every texture, picture and byte no longer used."""
    gltf = json.loads(json.dumps(gltf))
    for m in gltf.get("materials", []):
        if m.get("normalTexture", {}).get("scale", 1) == 0:
            del m["normalTexture"]
    refs: list = []
    _texture_refs(gltf.get("materials", []), refs)
    used_tex = sorted({r["index"] for r in refs})
    tex_map = {old: new for new, old in enumerate(used_tex)}
    for r in refs:
        r["index"] = tex_map[r["index"]]
    textures = [gltf["textures"][i] for i in used_tex]
    used_img = sorted({t.get("extensions", {}).get(WEBP, {}).get("source", t.get("source")) for t in textures} - {None})
    img_map = {old: new for new, old in enumerate(used_img)}
    for t in textures:
        if "source" in t:
            t["source"] = img_map[t["source"]]
        if WEBP in t.get("extensions", {}):
            t["extensions"][WEBP]["source"] = img_map[t["extensions"][WEBP]["source"]]
    dropped_views = {img["bufferView"] for i, img in enumerate(gltf.get("images", [])) if i not in img_map and "bufferView" in img}
    gltf["textures"] = textures
    gltf["images"] = [gltf["images"][i] for i in used_img]
    if not dropped_views:
        return gltf, binary
    views = gltf["bufferViews"]
    keep = [i for i in range(len(views)) if i not in dropped_views]
    view_map = {old: new for new, old in enumerate(keep)}
    packed = bytearray()
    new_views = []
    for i in keep:
        v = dict(views[i])
        start = v.get("byteOffset", 0)
        chunk = binary[start : start + v["byteLength"]]
        packed += b"\0" * (-len(packed) % 4)
        v["byteOffset"] = len(packed)
        packed += chunk
        new_views.append(v)
    for holder, key in _buffer_view_refs(gltf):
        holder[key] = view_map[holder[key]]
    gltf["bufferViews"] = new_views
    gltf["buffers"][0]["byteLength"] = len(packed)
    return gltf, bytes(packed)


def clean_model(gltf: dict, binary: bytes) -> tuple[dict, bytes]:
    """The app copy: no JPEG fallbacks, no switched-off bump picture, and the colour picture without the painted grime."""
    gltf, binary = drop_texture_fallbacks(gltf, binary)
    gltf, binary = drop_switched_off_normal_maps(gltf, binary)
    idx = base_colour_image(gltf)
    view = gltf["bufferViews"][gltf["images"][idx]["bufferView"]]
    start = view.get("byteOffset", 0)
    picture = Image.open(io.BytesIO(binary[start : start + view["byteLength"]])).convert("RGB")
    cleaned = clean_suit_colours(np.asarray(picture).astype(np.float32) / 255)
    out = io.BytesIO()
    Image.fromarray((cleaned * 255 + 0.5).astype(np.uint8)).save(out, "WEBP", quality=90, method=6)
    return replace_image(gltf, binary, idx, out.getvalue(), "image/webp")


def main(argv: list[str] | None = None) -> None:
    src, dst = (argv or sys.argv[1:])[:2]
    data = Path(src).read_bytes()
    gltf, binary = clean_model(*read_glb(data))
    out = write_glb(gltf, binary)
    Path(dst).parent.mkdir(parents=True, exist_ok=True)
    Path(dst).write_bytes(out)
    for label, b in (("NASA file", data), ("app copy", out)):
        print(f"{label}: {len(b):,} bytes, sha256 {hashlib.sha256(b).hexdigest()}")


if __name__ == "__main__":
    main()
