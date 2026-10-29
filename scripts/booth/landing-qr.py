#!/usr/bin/env python3
"""Writes physician-ui/public/img/booth-landing-qr.svg, the Booth Mode Landing QR (#212).

Run: python3 scripts/booth/landing-qr.py   (needs the `qrcode` package). Rerun when the Portal origin changes.
"""
import pathlib
import qrcode
import qrcode.image.svg

LANDING_URL = 'https://physician-ui.vercel.app/'
OUT = pathlib.Path(__file__).resolve().parents[2] / 'physician-ui' / 'public' / 'img' / 'booth-landing-qr.svg'

# /login still says "On-premise" on master, so the QR must never land there.
assert 'login' not in LANDING_URL, LANDING_URL

qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=4)
qr.add_data(LANDING_URL)
qr.make(fit=True)
img = qr.make_image(image_factory=qrcode.image.svg.SvgPathFillImage)
OUT.write_bytes(img.to_string())
print(f'{OUT} -> {LANDING_URL}')
