from pathlib import Path

from PIL import Image, ImageDraw

OUTPUT = Path(__file__).resolve().parent.parent / "public"


def make_icon(size: int, name: str) -> None:
    image = Image.new("RGB", (size, size), "#070b14")
    draw = ImageDraw.Draw(image)
    unit = size / 128
    dim = {(0, 1), (1, 0), (1, 2)}
    for row in range(3):
        for column in range(3):
            left = (22 + 31 * column) * unit
            top = (22 + 31 * row) * unit
            draw.rounded_rectangle(
                (left, top, left + 22 * unit, top + 22 * unit),
                radius=3 * unit,
                fill="#477f77" if (row, column) in dim else "#8dffe2",
            )
    image.save(OUTPUT / name, optimize=True)


for icon_size, filename in (
    (192, "icon-192.png"),
    (512, "icon-512.png"),
    (180, "apple-touch-icon.png"),
    (512, "icon-maskable-512.png"),
):
    make_icon(icon_size, filename)
