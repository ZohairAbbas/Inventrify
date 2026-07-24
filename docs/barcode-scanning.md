# Barcode scanning

Inventorify reads barcodes anywhere you see the scan field (▮▯▮) — stock adjustments,
purchase-order receiving, and the inventory search box. The barcode itself comes from
Shopify: whatever is in a variant's **Barcode** field syncs automatically on the hourly
catalogue pull, and a scan matches it exactly (falling back to SKU for variants that have
no barcode).

## How the scan field works

A hardware barcode scanner — USB or Bluetooth — behaves as a keyboard. It types the code
far faster than a person can and then sends **Enter**. So there is nothing to install and
no device to pair with Inventorify: click into the scan field, scan, and the code
resolves. The field submits on Enter only (never on a timer), clears itself, and keeps
focus, so you can scan a run of items without touching the mouse.

If a code matches nothing, or matches two variants (a duplicate barcode in Shopify), the
field says so rather than guessing — because receiving and counting act on the result
immediately.

## No scanner? Use your phone

You don't need to buy hardware to try this. A free app turns an Android or iPhone into a
wireless scanner that types straight into the Inventorify field, exactly as a USB scanner
would.

**Recommended: "Barcode to PC: Wi-Fi scanner"** (on the Google Play Store, and the App
Store). It pairs the phone's camera with a small helper app on your computer and sends
each scan to wherever your cursor is.

1. Install **Barcode to PC** on the phone from the Play Store.
2. Install the free **Barcode to PC server** on the Windows PC (barcodetopc.com).
3. Put the phone and the PC **on the same Wi-Fi network** — this is the part that matters
   most; the two connect directly over the local network, so a shared Wi-Fi is what makes
   it reliable and fast. A phone on mobile data and a PC on Wi-Fi will not find each other.
4. Open Inventorify, click into the scan field, and scan with the phone. The code appears
   in the field and resolves as if you had typed it.

Best results: **Android phone + Windows PC on the same Wi-Fi.** The pairing is most stable
there. It works on iPhone and macOS too, but the Android/Windows combination is the one to
start with if you have the choice.

Any app that operates in "keyboard wedge" mode — i.e. it types the scanned code and sends
Enter — will work with Inventorify's scan field, since that is all a hardware scanner does.

## Editing barcodes

Barcodes are managed in Shopify (Products → a variant → **Barcode**), not in Inventorify,
so the two never disagree. Add or correct a barcode there and it appears here after the
next sync — or run **Sync inventory** from the dashboard to pull it immediately.
