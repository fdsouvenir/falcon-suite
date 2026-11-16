// Stylesheets and SVG and PNG artwork are bundled by `openclaw plugins build`; tsc only needs to
// accept the imports.
declare module '*.css';
declare module '*.svg' {
	const svg: string;
	export default svg;
}
declare module '*.png' {
	const png: Uint8Array;
	export default png;
}
// The qrcode package (MIT) ships no types for its encoder and SVG renderer.
declare module 'qrcode/lib/core/qrcode.js' {
	export function create(text: string, options?: { errorCorrectionLevel?: string }): unknown;
}
declare module 'qrcode/lib/renderer/svg-tag.js' {
	export function render(
		qr: unknown,
		options?: { margin?: number; color?: { dark?: string; light?: string } }
	): string;
}
