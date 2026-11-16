// QR codes drawn in the page from text, with the qrcode package's encoder and SVG renderer
// (bundled; no network).
import { create } from 'qrcode/lib/core/qrcode.js';
import { render } from 'qrcode/lib/renderer/svg-tag.js';

export function qrSvg(text: string): string {
	return render(create(text, { errorCorrectionLevel: 'M' }), {
		margin: 4,
		color: { dark: '#000000ff', light: '#ffffffff' }
	});
}
