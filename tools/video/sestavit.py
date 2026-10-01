# Sestaví prezentační video (LinkedIn, 1920 × 1080, do 30 s) ze záběrů v postup/video/zabery:
# ořez na 16:9, prolínání, české popisky. Výstup: postup/video/moje-tapeta-linkedin.mp4
#
# Použití: python tools/video/sestavit.py
import os
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SHOTS = os.path.join(ROOT, 'postup', 'video', 'zabery')
WORK = os.path.join(ROOT, 'postup', 'video', 'texty')
OUT = os.path.join(ROOT, 'postup', 'video', 'moje-tapeta-linkedin.mp4')
FADE = 0.4

# záběr, od které sekundy nahrávky, délka (s)
CLIPS = [
    ('01-uvod', 0.5, 3.0),
    ('02-den', 0.3, 3.0),
    ('03-jaro', 0.5, 3.0),
    ('04-podzim', 0.5, 3.0),
    ('05-zima', 0.5, 3.2),
    ('06-bourka', 0.2, 3.0),     # blesk v 0,5–1,2 s nahrávky
    ('07-duha', 0.5, 2.8),
    ('08-soumrak', 0.5, 3.0),
    ('09-noc', 0.0, 3.0),        # padající hvězda hned na začátku
    ('10-zaver', 0.3, 3.6),      # hejno ptáků
]

# Začátky záběrů ve výsledném videu.
starts = []
t = 0.0
for _, _, length in CLIPS:
    starts.append(t)
    t += length - FADE
TOTAL = t + FADE

# Popisky: od, do, velký text, malý text (v sekundách výsledného videa).
S = starts
TEXTS = [
    (0.3, S[1] + 0.1, 'Živá tapeta pro Windows', 'Gosausee a Dachstein · skutečný terén Rakouských Alp'),
    (S[1] + 0.3, S[2] + 0.1, 'Den podle skutečného času', 'slunce a stíny hor počítané pro polohu Gosau'),
    (S[2] + 0.3, S[3] + 0.1, 'Roční období podle kalendáře', 'jaro: kvetoucí stromy, loďky, labutě a kachny'),
    (S[3] + 0.3, S[4] + 0.1, 'Roční období podle kalendáře', 'podzim: zlaté modříny, padající listí, mraky v lesích'),
    (S[4] + 0.3, S[5] + 0.1, 'Roční období podle kalendáře', 'zima: zamrzlé jezero, bruslaři, sněžení do hloubky'),
    (S[5] + 0.3, S[7] + 0.1, 'Skutečné počasí v Gosau', 'déšť, bouřka i duha podle dat Open-Meteo'),
    (S[7] + 0.3, S[8] + 0.1, 'Soumrak a noc', 'mlha nad jezerem, lucerna na loďce, okno chaty'),
    (S[8] + 0.3, S[9] + 0.1, 'Skutečná noční obloha', '5 080 hvězd z katalogu, Mléčná dráha, padající hvězdy'),
    (S[9] + 0.3, TOTAL - 0.05, 'Moje tapeta', 'pod ikonami plochy · při hře se sama zastaví'),
]
CREDIT = (S[9] + 0.8, TOTAL - 0.05, 'Made with Claude – model Opus 5.5')

FONT_BOLD = 'C\\:/Windows/Fonts/segoeuib.ttf'
FONT = 'C\\:/Windows/Fonts/segoeui.ttf'


def alpha(a, b):
    return f"if(lt(t,{a:.2f}),0,if(lt(t,{a + 0.35:.2f}),(t-{a:.2f})/0.35,if(lt(t,{b - 0.35:.2f}),1,if(lt(t,{b:.2f}),({b:.2f}-t)/0.35,0))))"


def textfile(name, text):
    os.makedirs(WORK, exist_ok=True)
    path = os.path.join(WORK, name + '.txt')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)
    return path.replace('\\', '/').replace(':', '\\:')


def main():
    inputs = []
    parts = []
    for i, (name, start, length) in enumerate(CLIPS):
        inputs += ['-i', os.path.join(SHOTS, name + '.webm')]
        parts.append(
            f"[{i}:v]trim=start={start}:duration={length},setpts=PTS-STARTPTS,fps=30,"
            f"scale=-2:1080:flags=lanczos,crop=1920:1080,format=yuv420p,setsar=1[v{i}]")
    # Prolínání po sobě jdoucích záběrů.
    prev = 'v0'
    for i in range(1, len(CLIPS)):
        offset = starts[i]
        parts.append(f"[{prev}][v{i}]xfade=transition=fade:duration={FADE}:offset={offset:.2f}[x{i}]")
        prev = f'x{i}'
    # Plynulé ztmavení dole (přechod z průhledné do 40 % černé), ať jsou popisky čitelné
    # i na sněhu, bez viditelných hran.
    n = len(CLIPS)
    inputs += ['-f', 'lavfi', '-i', 'color=c=black:s=1920x380:d=1,format=rgba']
    parts.append(f"[{n}:v]geq=r=0:g=0:b=0:a='105*pow(Y/H,1.6)',loop=-1:1:0,setpts=N/30/TB[shade]")
    parts.append(f"[{prev}][shade]overlay=0:H-h:shortest=1[shaded]")
    draw = ["[shaded]null"]
    for k, (a, b, big, small) in enumerate(TEXTS):
        big_size = 92 if k in (0, len(TEXTS) - 1) else 64
        draw.append(
            f"drawtext=fontfile='{FONT_BOLD}':textfile='{textfile(f'velky{k}', big)}':fontsize={big_size}:fontcolor=white:"
            f"shadowcolor=black@0.55:shadowx=2:shadowy=2:x=96:y=h-{230 if big_size > 80 else 210}:alpha='{alpha(a, b)}'")
        draw.append(
            f"drawtext=fontfile='{FONT}':textfile='{textfile(f'maly{k}', small)}':fontsize=40:fontcolor=white@0.92:"
            f"shadowcolor=black@0.55:shadowx=2:shadowy=2:x=98:y=h-120:alpha='{alpha(a + 0.15, b)}'")
    a, b, credit = CREDIT
    draw.append(
        f"drawtext=fontfile='{FONT}':textfile='{textfile('credit', credit)}':fontsize=34:fontcolor=white@0.85:"
        f"shadowcolor=black@0.5:shadowx=2:shadowy=2:x=w-tw-96:y=h-120:alpha='{alpha(a, b)}'")
    draw[-1] += ",fade=t=in:st=0:d=0.5,fade=t=out:st=%.2f:d=0.6[out]" % (TOTAL - 0.6)
    parts.append(','.join(draw))
    script = os.path.join(WORK, 'filtr.txt')
    with open(script, 'w', encoding='utf-8') as f:
        f.write(';\n'.join(parts))
    cmd = ['ffmpeg', '-v', 'error', '-y', *inputs, '-filter_complex_script', script, '-map', '[out]',
           '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
           '-movflags', '+faststart', '-t', f'{TOTAL:.2f}', OUT]
    subprocess.run(cmd, check=True)
    print(f'Hotovo: {OUT} ({TOTAL:.1f} s)')


if __name__ == '__main__':
    main()
