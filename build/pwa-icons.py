"""Regenerate Finance's original app icons using only Python's standard library."""
from pathlib import Path
import struct
import zlib


def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)


def icon(size):
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            px, py = (x + .5) / size, (y + .5) / size
            # A geometric F, inset to stay legible in launcher masks.
            mark = (.30 <= px <= .43 and .24 <= py <= .76) or (.30 <= px <= .72 and .24 <= py <= .36) or (.30 <= px <= .64 and .46 <= py <= .58)
            rows.extend((245, 246, 243) if mark else (53, 101, 75))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(bytes(rows), 9)) + chunk(b'IEND', b'')


if __name__ == '__main__':
    destination = Path(__file__).resolve().parent.parent / 'public' / 'icons'
    destination.mkdir(parents=True, exist_ok=True)
    for size in (192, 512):
        path = destination / f'finance-{size}.png'
        path.write_bytes(icon(size))
        print(f'{path}: {size}x{size}')
