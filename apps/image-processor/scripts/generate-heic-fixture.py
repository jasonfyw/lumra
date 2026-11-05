import sys
from PIL import Image
import pillow_heif

pillow_heif.register_heif_opener()

# 400x300 gradient with a distinct top-left marker so orientation can be checked.
w, h = 400, 300
img = Image.new("RGB", (w, h))
px = img.load()
for y in range(h):
    for x in range(w):
        px[x, y] = (int(255 * x / (w - 1)), int(255 * y / (h - 1)), 128)
for y in range(40):
    for x in range(40):
        px[x, y] = (255, 0, 0)

img.save(sys.argv[1], format="HEIF", quality=40)
check = Image.open(sys.argv[1])
print(check.format, check.size, check.mode)
