// Static, self-contained pages: no provider diagnostics, callback values, scripts or third-party assets.
const style = `
:root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172b34;background:#f4f8f8}
*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:32px 20px;background:radial-gradient(ellipse at 20% 10%,#d9eeea,transparent 55%),radial-gradient(ellipse at 90% 90%,#e5e6fa,transparent 50%),#f4f8f8}
main{width:100%;max-width:560px;text-align:center}.brand{font-size:13px;font-weight:750;letter-spacing:.16em;text-transform:uppercase;color:#426169;margin-bottom:30px}.card{padding:40px 36px;background:#fff;border:1px solid #e0eae9;border-radius:28px;box-shadow:0 20px 70px #234a4210}.art{width:240px;max-width:100%;height:150px;margin:0 auto 24px;display:block}.eyebrow{font-size:12px;font-weight:750;letter-spacing:.12em;text-transform:uppercase;color:#167663;margin:0 0 12px}h1{font-size:clamp(28px,6vw,36px);letter-spacing:-.04em;line-height:1.15;margin:0 0 18px}p{font-size:16px;line-height:1.65;color:#566a70;margin:0}.next{margin-top:28px;padding:20px;border-radius:16px;background:#eef7f4;color:#254e43;font-weight:600}.note{margin-top:14px;font-size:14px}.footer{font-size:12px;color:#71858a;margin-top:24px}.attention .eyebrow{color:#8a6129}.attention .next{background:#fbf5e9;color:#725426}@media(max-width:420px){.card{padding:30px 22px}}`;

export async function callbackPage(
	outcome: 'received' | 'cancelled' | 'expired',
	headers: Record<string, string>
) {
	const received = outcome === 'received';
	const title = received
		? 'Sign-in received'
		: outcome === 'cancelled'
			? 'Sign-in wasn’t completed'
			: 'This sign-in has expired';
	const detail = received
		? 'Thanks — your sign-in has been securely handed back. Your agent will finish connecting your account.'
		: outcome === 'cancelled'
			? 'This sign-in was cancelled. Return to your agent if you’d like to try again.'
			: 'This sign-in link is no longer available. Return to your agent and start a new sign-in.';
	const mark = received
		? '<path d="m105 73 11 11 23-26" fill="none" stroke="white" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>'
		: '<path d="M120 52v25m0 14v1" fill="none" stroke="white" stroke-width="7" stroke-linecap="round"/>';
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Falcon Link</title><style>${style}</style></head><body><main class="${received ? 'success' : 'attention'}"><div class="brand">Falcon Link</div><section class="card" aria-labelledby="title"><svg class="art" viewBox="0 0 240 150" fill="none" aria-hidden="true"><circle cx="120" cy="75" r="69" fill="#f0f7f5"/><circle cx="120" cy="75" r="55" stroke="#d4e7e2" stroke-dasharray="4 7"/><path d="M30 75h46m88 0h46" stroke="#a4cec2" stroke-width="3" stroke-linecap="round"/><rect x="9" y="54" width="42" height="42" rx="14" fill="#e5f1ee"/><path d="M22 75h16m-8-8v16" stroke="#448c79" stroke-width="3" stroke-linecap="round"/><rect x="189" y="54" width="42" height="42" rx="14" fill="#eeecfa"/><path d="M203 70h14m-14 6h14m-14 6h8" stroke="#8c80b8" stroke-width="3" stroke-linecap="round"/><circle cx="120" cy="75" r="37" fill="${received ? '#23866d' : '#a37d3f'}"/>${mark}<circle cx="57" cy="29" r="4" fill="#a4cec2"/><circle cx="190" cy="119" r="5" fill="#cec8e6"/><path d="M184 25v10m-5-5h10" stroke="#bcb3d9" stroke-width="2" stroke-linecap="round"/></svg><p class="eyebrow">${received ? 'You’re all set here' : 'Let’s try that again'}</p><h1 id="title">${title}</h1><p>${detail}</p><p class="next">You can close this tab and return to your agent.</p>${received ? '<p class="note">There’s nothing else to do on this page.</p>' : ''}</section><p class="footer">Falcon Link · A little less busywork.</p></main></body></html>`;
	const hash = btoa(
		String.fromCharCode(
			...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(style)))
		)
	);
	return new Response(html, {
		status: outcome === 'expired' ? 400 : 200,
		headers: {
			...headers,
			'Content-Type': 'text/html; charset=utf-8',
			'Content-Security-Policy': `default-src 'none'; style-src 'sha256-${hash}'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`
		}
	});
}
