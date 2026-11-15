"""The crew figure's model file: the app copy of NASA's Z2 Spacesuit without the JPEG fallbacks."""

import json
from pathlib import Path

import pytest

from baramger_pipeline.suit_model import WEBP, drop_texture_fallbacks, read_glb, write_glb

APP_COPY = Path(__file__).resolve().parents[2] / "app" / "public" / "models" / "z2-spacesuit.glb"


def small_glb() -> tuple[dict, bytes]:
    geometry = b"G" * 12
    jpeg = b"J" * 10
    webp = b"W" * 6
    binary = geometry + jpeg + b"\0\0" + webp
    gltf = {
        "asset": {"version": "2.0"},
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": 12},
            {"buffer": 0, "byteOffset": 12, "byteLength": 10},
            {"buffer": 0, "byteOffset": 24, "byteLength": 6},
        ],
        "accessors": [{"bufferView": 0, "componentType": 5126, "count": 1, "type": "VEC3"}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "extensions": {"KHR_draco_mesh_compression": {"bufferView": 0, "attributes": {"POSITION": 0}}}}]}],
        "images": [{"bufferView": 1, "mimeType": "image/jpeg"}, {"bufferView": 2, "mimeType": "image/webp"}],
        "textures": [{"source": 0, "extensions": {WEBP: {"source": 1}}}],
        "extensionsUsed": ["KHR_draco_mesh_compression", WEBP],
        "extensionsRequired": ["KHR_draco_mesh_compression"],
    }
    return gltf, binary


def test_the_fallback_picture_and_its_bytes_go():
    gltf, binary = drop_texture_fallbacks(*small_glb())
    assert [i["mimeType"] for i in gltf["images"]] == ["image/webp"]
    assert gltf["textures"] == [{"extensions": {WEBP: {"source": 0}}}]
    assert WEBP in gltf["extensionsRequired"]
    assert len(gltf["bufferViews"]) == 2
    geom, webp = gltf["bufferViews"]
    assert binary[geom["byteOffset"] : geom["byteOffset"] + 12] == b"G" * 12
    assert binary[webp["byteOffset"] : webp["byteOffset"] + 6] == b"W" * 6
    assert webp["byteOffset"] % 4 == 0
    assert gltf["images"][0]["bufferView"] == 1
    assert gltf["accessors"][0]["bufferView"] == 0
    assert gltf["meshes"][0]["primitives"][0]["extensions"]["KHR_draco_mesh_compression"]["bufferView"] == 0
    assert b"J" not in binary


def test_a_texture_without_webp_keeps_its_picture():
    gltf, binary = small_glb()
    gltf["textures"] = [{"source": 0}]
    out, out_bin = drop_texture_fallbacks(gltf, binary)
    assert out["textures"] == [{"source": 0}]
    assert out_bin == binary


def test_a_file_survives_writing_and_reading():
    gltf, binary = drop_texture_fallbacks(*small_glb())
    again, again_bin = read_glb(write_glb(gltf, binary))
    assert again == gltf
    assert again_bin[: len(binary)] == binary


@pytest.mark.skipif(not APP_COPY.exists(), reason="the app copy is made by suit_model.main")
def test_the_app_copy_has_only_webp_pictures_and_nasas_mesh():
    gltf, binary = read_glb(APP_COPY.read_bytes())
    assert {i["mimeType"] for i in gltf["images"]} == {"image/webp"}
    assert "normalTexture" not in gltf["materials"][0]  # NASA's bump picture is off (strength 0) and left out
    assert len(gltf["images"]) == 2
    assert WEBP in gltf["extensionsRequired"]
    assert "KHR_draco_mesh_compression" in gltf["extensionsRequired"]
    assert [n.get("name") for n in gltf["nodes"]] == ["Z2"]
    assert APP_COPY.stat().st_size < 3_000_000
    # NASA's mesh: 30,904 triangles, about 1.93 m from the boots to the top of the helmet
    accessors = gltf["accessors"]
    prim = gltf["meshes"][0]["primitives"][0]
    assert accessors[prim["indices"]]["count"] // 3 == 30_904
    z = accessors[prim["attributes"]["POSITION"]]
    assert z["max"][2] - z["min"][2] == pytest.approx(1.935, abs=0.01)
    json.dumps(gltf)  # plain JSON only


# ---- the painted grime


def fabric_picture() -> "np.ndarray":
    import numpy as np

    img = np.ones((200, 200, 3), np.float32)  # pure white background
    img[20:180, 20:180] = 0.85  # a white fabric piece
    yy, xx = np.mgrid[0:200, 0:200]
    blob = np.exp(-(((yy - 70) ** 2 + (xx - 70) ** 2) / (2 * 22**2)))  # a soft dark patch of grime
    img[20:180, 20:180] *= (1 - 0.9 * blob[20:180, 20:180])[..., None]
    img[120:123, 30:170] = 0.45  # a seam: a thin dark line
    img[140:170, 130:160] = 0.03  # a black part with sharp edges
    img[100:103, 100:103] = 0.05  # a small dark grime dot
    img[25:30, 30:170] = (0.75, 0.08, 0.08)  # a red stripe
    return img


def test_grime_goes_and_the_fabric_is_even():
    import numpy as np

    from baramger_pipeline.suit_model import FABRIC_WHITE, clean_suit_colours

    out = clean_suit_colours(fabric_picture())
    lum = out @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    assert lum[70, 70] > 0.8  # the middle of the grime patch is white now
    assert abs(lum[60:90, 60:90].mean() - FABRIC_WHITE) < 0.05
    assert lum[101, 101] > 0.8  # a small dark dot is grime too


def test_seams_black_parts_stripes_and_background_stay():
    import numpy as np

    from baramger_pipeline.suit_model import clean_suit_colours

    src = fabric_picture()
    out = clean_suit_colours(src)
    lum = out @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    assert lum[121, 100] < lum[110, 100] - 0.2  # the seam is still a dark line
    assert np.allclose(out[150:160, 140:150], src[150:160, 140:150], atol=0.01)  # the black part
    assert np.allclose(out[27, 40:160], src[27, 40:160], atol=0.02)  # the red stripe
    assert np.allclose(out[5, 5], 1.0)  # the background


def test_replacing_a_picture_keeps_every_other_byte():
    gltf, binary = drop_texture_fallbacks(*small_glb())
    from baramger_pipeline.suit_model import replace_image

    out, out_bin = replace_image(gltf, binary, 0, b"NEWPICTURE", "image/webp")
    geom, pic = out["bufferViews"]
    assert out_bin[geom["byteOffset"] : geom["byteOffset"] + 12] == b"G" * 12
    assert out_bin[pic["byteOffset"] : pic["byteOffset"] + pic["byteLength"]] == b"NEWPICTURE"
    assert out["buffers"][0]["byteLength"] == len(out_bin)


def test_a_switched_off_normal_map_goes_with_its_picture():
    from baramger_pipeline.suit_model import drop_switched_off_normal_maps

    gltf, binary = drop_texture_fallbacks(*small_glb())
    gltf["materials"] = [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 1}}, "normalTexture": {"index": 0, "scale": 0}}]
    # a second picture (the colour one) and its texture
    gltf["bufferViews"].append({"buffer": 0, "byteOffset": len(binary) + (-len(binary) % 4), "byteLength": 4})
    binary = binary + b"\0" * (-len(binary) % 4) + b"COLR"
    gltf["buffers"][0]["byteLength"] = len(binary)
    gltf["images"].append({"bufferView": 2, "mimeType": "image/webp"})
    gltf["textures"].append({"extensions": {WEBP: {"source": 1}}})
    out, out_bin = drop_switched_off_normal_maps(gltf, binary)
    assert "normalTexture" not in out["materials"][0]
    assert out["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"]["index"] == 0
    assert len(out["images"]) == 1 and len(out["textures"]) == 1
    v = out["bufferViews"][out["images"][0]["bufferView"]]
    assert out_bin[v["byteOffset"] : v["byteOffset"] + 4] == b"COLR"
    assert b"W" * 6 not in out_bin  # the bump picture's bytes are gone


def test_a_normal_map_that_is_on_stays():
    from baramger_pipeline.suit_model import drop_switched_off_normal_maps

    gltf, binary = drop_texture_fallbacks(*small_glb())
    gltf["materials"] = [{"normalTexture": {"index": 0, "scale": 1}}]
    out, out_bin = drop_switched_off_normal_maps(gltf, binary)
    assert out["materials"][0]["normalTexture"]["index"] == 0
    assert out_bin == binary

