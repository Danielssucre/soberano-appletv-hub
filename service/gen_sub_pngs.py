#!/usr/bin/env python3
"""Renderiza cues WebVTT a PNGs RGBA (franja 1920x240) + lista concat para ffmpeg overlay.
Uso: gen_sub_pngs.py <vtt> <outdir> [offset_seg]"""
import sys, os, re, html
from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 240
FONT_CANDIDATES = ["/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/Supplemental/Arial.ttf",
                   "/System/Library/Fonts/SFNS.ttf", "/Library/Fonts/Arial.ttf"]

def load_font(size):
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try: return ImageFont.truetype(p, size)
            except Exception: pass
    return ImageFont.load_default()

def ts(t):
    t = t.strip().replace(',', '.')
    parts = t.split(':')
    sec = 0.0
    for p in parts: sec = sec * 60 + float(p)
    return sec

def parse(path):
    txt = open(path, encoding='utf-8', errors='replace').read().replace('\r', '')
    cues = []
    for block in re.split(r'\n\s*\n', txt):
        lines = [l for l in block.split('\n') if l.strip() != '']
        for i, l in enumerate(lines):
            if '-->' in l:
                a, b = l.split('-->')
                try:
                    st, en = ts(a), ts(b.strip().split(' ')[0])
                except ValueError:
                    break
                body = ' '.join(lines[i+1:]) if False else '\n'.join(lines[i+1:])
                body = html.unescape(re.sub(r'<[^>]+>|\{\\[^}]*\}', '', body)).strip()
                if body and en > st: cues.append((st, en, body))
                break
    cues.sort()
    return cues

def render(text, font):
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    lines = text.split('\n')[:3]
    lh = int(font.size * 1.22)
    y = H - 36 - lh * len(lines)
    for ln in lines:
        w = d.textlength(ln, font=font)
        d.text(((W - w) / 2, y), ln, font=font, fill=(255, 255, 255, 255),
               stroke_width=4, stroke_fill=(0, 0, 0, 255))
        y += lh
    return img

def main():
    vtt, out = sys.argv[1], sys.argv[2]
    off = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0
    os.makedirs(out, exist_ok=True)
    font = load_font(56)
    cues = [(max(0.0, s + off), max(0.0, e + off), t) for s, e, t in parse(vtt)]
    Image.new('RGBA', (W, H), (0, 0, 0, 0)).save(os.path.join(out, 'blank.png'))
    lst, cur = [], 0.0
    for i, (s, e, t) in enumerate(cues):
        if s < cur: s = cur
        if e <= s: continue
        if s > cur:
            lst.append(("blank.png", s - cur))
        fn = f"c{i:05d}.png"
        render(t, font).save(os.path.join(out, fn), optimize=False, compress_level=1)
        lst.append((fn, e - s))
        cur = e
    lst.append(("blank.png", 36000.0))
    with open(os.path.join(out, 'concat.txt'), 'w') as f:
        for fn, d in lst:
            f.write(f"file '{os.path.join(out, fn)}'\nduration {d:.3f}\n")
        f.write(f"file '{os.path.join(out, 'blank.png')}'\n")
    print(len(cues))

main()
