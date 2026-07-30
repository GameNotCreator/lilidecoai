import io

from PIL import Image, ImageDraw


def image_bytes(
    width: int = 800,
    height: int = 600,
    *,
    product: bool = False,
) -> bytes:
    image = Image.new("RGB", (width, height), (224, 216, 201))
    draw = ImageDraw.Draw(image)
    if product:
        draw.ellipse(
            (width * 0.32, height * 0.12, width * 0.68, height * 0.9),
            fill=(166, 105, 72),
        )
    else:
        draw.rectangle((0, height * 0.65, width, height), fill=(128, 101, 78))
        draw.rectangle(
            (width * 0.16, height * 0.18, width * 0.72, height * 0.58),
            fill=(185, 195, 170),
        )
    output = io.BytesIO()
    image.save(output, "PNG")
    return output.getvalue()

