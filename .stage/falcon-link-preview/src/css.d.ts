// Stylesheets and SVG artwork are bundled by `openclaw plugins build`; tsc only needs to
// accept the imports.
declare module '*.css';
declare module '*.svg' {
	const svg: string;
	export default svg;
}
