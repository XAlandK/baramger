"""Make the GitHub copy of docs/Baramger-Like-Im-Five.html.

GitHub drops <style> and <script> from Markdown, so the cartoon page cannot show
there as it is. This writes:
  <out>/README.md       English, plain GitHub Markdown
  <out>/README.ckb.md   Central Kurdish (Sorani), inside <div dir="rtl">
  <out>/img/*.svg       each drawing as its own SVG; text in a drawing uses an
                        embedded subset of Playpen Sans Arabic (only its letters)
  <out>/img/photo-*.jpg the real photos of the page (answers 5, 6, 7 and 17), taken out of their
                        data: URLs and named by each <img data-file="...">

Run it again after any change to docs/Baramger-Like-Im-Five.html (from the repo root):
  curl -sSL -o /tmp/PlaypenSansArabic.ttf \
    "https://raw.githubusercontent.com/google/fonts/main/ofl/playpensansarabic/PlaypenSansArabic%5Bwght%5D.ttf"
  uv run --python 3.12 --with beautifulsoup4 --with html5lib --with fonttools --with brotli \
    python -I docs/like-im-five/make_github_copy.py docs/Baramger-Like-Im-Five.html docs/like-im-five /tmp/PlaypenSansArabic.ttf
The preview pictures (img/preview-*.jpg) are screenshots of the HTML page and are not made by this script.
"""
import base64
import copy
import html
import io
import os
import re
import sys

from bs4 import BeautifulSoup, Comment, NavigableString, Tag
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

src, out_dir, font_path = sys.argv[1:4]
soup = BeautifulSoup(open(src, encoding="utf-8").read(), "html5lib")  # html5lib keeps SVG names (viewBox, clipPath)
img_dir = os.path.join(out_dir, "img")
os.makedirs(img_dir, exist_ok=True)

SYMBOLS = {s["id"]: s for s in soup.find_all("symbol")}
_b = io.BytesIO()
instancer.instantiateVariableFont(TTFont(font_path), {"wght": 700}).save(_b)
BOLD = _b.getvalue()
NOTE = ("<!-- Cartoon drawing from docs/Baramger-Like-Im-Five.html (not map data). Text font: a subset of "
        "Playpen Sans Arabic, Copyright 2023 The Playpen Sans Project Authors "
        "(https://github.com/TypeTogether/Playpen-Sans), SIL Open Font License 1.1. -->")


def font_b64(text: str) -> str:
    f = TTFont(io.BytesIO(BOLD))
    o = subset.Options()
    o.flavor = "woff2"
    o.layout_features = ["*"]  # Arabic shaping (joined letter forms)
    o.hinting = False
    o.desubroutinize = True
    o.notdef_outline = True
    s = subset.Subsetter(o)
    s.populate(text=text)
    s.subset(f)
    b = io.BytesIO()
    f.flavor = "woff2"
    f.save(b)
    return base64.b64encode(b.getvalue()).decode("ascii")


def export_svg(svg: Tag, name: str, background: str | None = None) -> str:
    vb = svg.get("viewBox")
    _, _, w, h = vb.split()
    used = sorted({u.get("href", "").lstrip("#") for u in svg.find_all("use")})
    texts = "".join(t.get_text() for t in svg.find_all("text"))
    style = ""
    if texts.strip():
        style = ('<style>@font-face{font-family:"Kid";src:url(data:font/woff2;base64,' + font_b64(texts)
                 + ') format("woff2")}text{font-family:"Kid","Comic Sans MS",cursive;font-weight:700}</style>')
    defs = "<defs>" + "".join(str(SYMBOLS[u]) for u in used if u in SYMBOLS) + "</defs>"
    bg = f'<rect width="{w}" height="{h}" rx="24" fill="{background}"/>' if background else ""
    inner = "".join(str(c) for c in svg.contents)
    label = svg.get("aria-label", "")
    doc = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" width="{w}" height="{h}" role="img" '
           f'aria-label="{html.escape(label)}">\n{NOTE}\n{style}{defs}{bg}{inner}</svg>\n')
    with open(os.path.join(img_dir, name), "w", encoding="utf-8") as fh:
        fh.write(doc)
    return label


SWATCH = {"#B8B2AA": "⬜", "#59C36A": "🟩", "#ECB026": "🟨", "#D63027": "🟥"}
BOX = {"app": "📱", "note": "📝", "fact": "💡"}


def write_photo(src: str, name: str) -> None:
    """A real photo of the page, saved from its data: URL (both languages share the file)."""
    m = re.match(r"data:image/jpeg;base64,(.*)", src, re.S)
    if not m or not re.fullmatch(r"photo-[a-z0-9-]+\.jpg", name):
        raise ValueError(f"unexpected photo: {name}")
    data = base64.b64decode(m.group(1))
    path = os.path.join(img_dir, name)
    if not os.path.exists(path) or open(path, "rb").read() != data:
        with open(path, "wb") as fh:
            fh.write(data)


def photo_lines(gallery: Tag, ku: bool) -> list[str]:
    """Each photo: the picture, its title and caption, then its credit line."""
    out = []
    for fig in gallery.find_all("figure", class_="photo", recursive=False):
        img = fig.find("img")
        write_photo(img["src"], img["data-file"])
        cap = copy.copy(fig.find("figcaption"))
        title = cap.find("b", recursive=False)
        credit = cap.find(class_="credit")
        head = inline(title, ku).strip()
        cred = re.sub(r" +", " ", inline(credit, ku)).strip()
        title.extract()
        credit.extract()
        body = re.sub(r" +", " ", inline(cap, ku)).strip()
        out += [f'<p align="center"><img src="img/{img["data-file"]}" width="360" alt="{html.escape(img.get("alt", ""))}"></p>', "",
                f"{bold(head, ku)} · {body}", "", f"<sub>{cred}</sub>", ""]
    return out


def bold(text: str, ku: bool) -> str:
    text = text.strip()
    if not text:
        return ""
    return f"<b>{text}</b>" if ku else f"**{text}**"


def inline(node: Tag, ku: bool, skip=()) -> str:
    out = []
    for c in node.children:
        if isinstance(c, Comment):
            continue
        if isinstance(c, NavigableString):
            out.append(re.sub(r"\s+", " ", str(c)))
            continue
        cls = c.get("class", [])
        if c.name in skip:
            continue
        if c.name in ("b", "strong"):
            out.append(bold(inline(c, ku), ku))
        elif c.name == "a":
            out.append(f"[{inline(c, ku).strip()}]({c['href']})")
        elif c.name == "bdi":
            out.append(f"<bdi>{inline(c, ku)}</bdi>")
        elif c.name == "span" and "sw" in cls:
            colour = re.search(r"#[0-9A-Fa-f]{6}", c.get("style", "")).group(0).upper()
            out.append(SWATCH.get(colour, "■") + " ")
        elif c.name == "span" and "chip" in cls:
            out.append(bold(c.get_text(), ku) + " · ")
        elif c.name == "br":
            out.append("<br>")
        else:
            out.append(inline(c, ku, skip))
    return "".join(out)


def list_lines(lst: Tag, ku: bool, depth: int = 0) -> list[str]:
    lines, n = [], 0
    for li in lst.find_all("li", recursive=False):
        n += 1
        marker = f"{n}." if lst.name == "ol" else "-"
        lines.append("   " * depth + f"{marker} " + re.sub(r" +", " ", inline(li, ku, skip=("ul", "ol"))).strip())
        for sub in li.find_all(["ul", "ol"], recursive=False):
            lines += list_lines(sub, ku, depth + 1)
    return lines


def quote(lines: list[str]) -> list[str]:
    while lines and not lines[-1]:
        lines = lines[:-1]
    return [("> " + l) if l else ">" for l in lines] + [""]


def blocks(node: Tag, ku: bool) -> list[str]:
    out = []
    for c in node.children:
        if not isinstance(c, Tag):
            continue
        cls = c.get("class", [])
        if c.name == "p":
            out += [re.sub(r" +", " ", inline(c, ku)).strip(), ""]
        elif c.name == "h3":
            out += ["### " + inline(c, ku).strip(), ""]
        elif c.name == "h4":
            out += ["#### " + inline(c, ku).strip(), ""]
        elif c.name in ("ul", "ol"):
            out += list_lines(c, ku) + [""]
        elif c.name == "div" and "box" in cls:
            kind = next((k for k in BOX if k in cls), "app")
            title = inline(c.find(class_="tag"), ku)
            out += quote([f"{BOX[kind]} " + bold(title, ku), ""] + blocks(c, ku))
        elif c.name == "div" and "photos" in cls:
            out += photo_lines(c, ku)
        elif c.name == "div" and "pair" in cls:
            for mini in c.find_all(class_="mini", recursive=False):
                out += quote(blocks(mini, ku))
        elif c.name == "div":
            out += blocks(c, ku)
    return out


def page(pane: Tag, ku: bool) -> str:
    p = "ckb" if ku else "en"
    L: list[str] = []
    if ku:
        L += ['<div dir="rtl">', ""]
        L += ['<p align="center"><a href="README.md">English</a> · <b>کوردی</b></p>', ""]
    else:
        L += ['<p align="center"><b>English</b> · <a href="README.ckb.md">کوردی</a></p>', ""]

    hero = pane.find(class_="hero")
    alt = hero.find("svg").get("aria-label", "")
    L += [f'<p align="center"><img src="img/hero.svg" width="360" alt="{html.escape(alt)}"></p>', ""]
    L += ["# " + inline(hero.find("h1"), ku).replace("<br>", " ").strip(), ""]
    L += [f"<sub>{inline(hero.find(class_='kicker'), ku).strip()}</sub>", ""]
    L += [inline(hero.find(class_="sub"), ku).strip(), ""]
    L += [" · ".join(bold(inline(s, ku), ku) for s in hero.find(class_="badges").find_all("span")), ""]
    terms = hero.find(class_="terms")
    if terms:
        L += [inline(terms, ku).strip(), ""]
    if ku:
        L += quote(["🖍️ <b>ئەمە وەشانی <bdi>GitHub</bdi>ـە.</b> <bdi>GitHub</bdi> ناتوانێت پەڕە کارتۆنییەکە خۆی پیشان بدات. "
                    "بۆ دیزاینی تەواو و دوگمەی <b><bdi>English | کوردی</bdi></b>، فایلی "
                    "[<bdi>Baramger-Like-Im-Five.html</bdi>](../Baramger-Like-Im-Five.html) دابەزێنە و لە وێبگەڕێکدا بیکەرەوە."])
    else:
        L += quote(["🖍️ **This is the GitHub copy.** GitHub can't show the cartoon page itself. For the full design and the "
                    "**English | کوردی** button, download [`Baramger-Like-Im-Five.html`](../Baramger-Like-Im-Five.html) "
                    "and open it in a web browser."])

    main = pane.find("main")
    for nav in main.find_all("nav", recursive=False):
        title = nav.find_previous_sibling("h2")
        L += [f'<a id="{title["id"]}"></a>', "", "## " + inline(title, ku).strip(), ""]
        for a in nav.find_all("a"):
            n = a.find(class_="n").get_text(strip=True)
            a.find(class_="n").extract()
            L.append(f"- {bold(n, ku)} · [{inline(a, ku).strip()}]({a['href']})")
        L += [""]
    L += ["---", ""]

    for card in main.find_all("section", class_="card"):
        cid = card["id"]
        num = card.find(class_="num").get_text(strip=True)
        h2 = inline(card.find("h2"), ku).strip()
        svg = card.find("figure").find("svg")
        name = f"{p}-{cid.removeprefix('ku-')}.svg"
        alt = export_svg(svg, name)
        L += [f'<a id="{cid}"></a>', "", f"## {num}. {h2}", ""]
        L += [f'<p align="center"><img src="img/{name}" width="300" alt="{html.escape(alt)}"></p>', ""]
        L += blocks(card.find(class_="text"), ku)
        back = card.find("a", class_="back")
        L += [f"<sub>[{back.get_text(strip=True)}]({back['href']})</sub>", "", "---", ""]

    foot = main.find("footer")
    L += ['<p align="center"><img src="img/rover.svg" width="90" alt="rover"></p>', ""]
    for fp in foot.find_all("p"):
        L += [f"<sub>{inline(fp, ku).strip()}</sub>", ""]
    if not ku:
        L += ["<sub>Drawings: each `.svg` picture in `img/` is a cartoon made for this page. Text in the drawings uses a subset of "
              "Playpen Sans Arabic (SIL Open Font License 1.1). The `photo-*.jpg` pictures are the real photos of answers 5, 6, 7 and 17; "
              "their credits are under each photo.</sub>", ""]
    if ku:
        L += ["</div>", ""]
    text = "\n".join(L)
    return re.sub(r"\n{3,}", "\n\n", text)


panes = {p["data-pane"]: p for p in soup.find_all("div", class_="pane")}
# drawings shared by both languages
export_svg(panes["en"].find(class_="hero").find("svg"), "hero.svg", background="#26305C")
export_svg(panes["en"].find("footer").find("svg"), "rover.svg")
for lang, fname in (("en", "README.md"), ("ckb", "README.ckb.md")):
    with open(os.path.join(out_dir, fname), "w", encoding="utf-8") as fh:
        fh.write(page(panes[lang], lang == "ckb"))
files = sorted(os.listdir(img_dir))
svgs = [f for f in files if f.endswith(".svg")]
photos = [f for f in files if f.startswith("photo-")]
print(len(svgs), "drawings,", sum(os.path.getsize(os.path.join(img_dir, f)) for f in svgs) // 1024, "KB;",
      len(photos), "photos,", sum(os.path.getsize(os.path.join(img_dir, f)) for f in photos) // 1024, "KB")
for fname in ("README.md", "README.ckb.md"):
    print(fname, os.path.getsize(os.path.join(out_dir, fname)) // 1024, "KB")
