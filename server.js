const express = require('express');
const cors = require('cors');
const path = require('path');
const { Readable } = require('stream');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());

// Desativa cache local de respostas para evitar loop de pedaços de vídeo
app.disable('etag');

// Serve arquivos estáticos (HTML, CSS, imagens)
app.use(express.static(__dirname));

// Rota de proxy para converter HTTP em HTTPS nos fluxos e APIs
app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('URL ausente.');

    try {
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.get('host');
        const proxyBase = `${protocol}://${host}/proxy?url=`;

        const upstreamHeaders = {
            'User-Agent': 'VLC/3.0.18 LibVLC/3.0.18',
            'Accept': '*/*'
        };

        if (req.headers.range) {
            upstreamHeaders['Range'] = req.headers.range;
        }

        const upstreamRes = await fetch(targetUrl, {
            headers: upstreamHeaders,
            redirect: 'follow'
        });

        if (!upstreamRes.ok) {
            return res.status(upstreamRes.status).send(await upstreamRes.text());
        }

        const finalUrl = upstreamRes.url || targetUrl;
        const contentType = (upstreamRes.headers.get('content-type') || '').toLowerCase();

        // 1. Processamento de Playlist HLS (.m3u8)
        if (contentType.includes('mpegurl') || targetUrl.includes('.m3u8') || finalUrl.includes('.m3u8')) {
            const manifest = await upstreamRes.text();
            const baseUrl = new URL(finalUrl);

            const modified = manifest.split('\n').map(line => {
                const trimmed = line.trim();
                if (!trimmed) return line;

                if (trimmed.startsWith('#EXT-X-KEY:') && trimmed.includes('URI="')) {
                    return trimmed.replace(/URI="([^"]+)"/, (m, uri) => {
                        const abs = new URL(uri, baseUrl).toString();
                        return `URI="${proxyBase}${encodeURIComponent(abs)}"`;
                    });
                }

                if (trimmed.startsWith('#')) return line;

                const absLine = new URL(trimmed, baseUrl).toString();
                return `${proxyBase}${encodeURIComponent(absLine)}`;
            }).join('\n');

            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            return res.send(modified);
        }

        // 2. Segmentos de Vídeo (.ts / .mp4 / áudio) - STREAMING CONTÍNUO
        ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach(h => {
            const val = upstreamRes.headers.get(h);
            if (val) res.setHeader(h, val);
        });

        if (targetUrl.includes('.ts') || finalUrl.includes('.ts')) {
            res.setHeader('Content-Type', 'video/mp2t');
            res.setHeader('Cache-Control', 'public, max-age=3600');
        }

        // Transmissão direta por pipe sem guardar na memória
        if (upstreamRes.body) {
            const nodeStream = Readable.fromWeb(upstreamRes.body);
            nodeStream.pipe(res);
        } else {
            const arrayBuffer = await upstreamRes.arrayBuffer();
            res.send(Buffer.from(arrayBuffer));
        }

    } catch (err) {
        if (!res.headersSent) {
            res.status(502).json({ error: 'Falha no upstream', message: err.message });
        }
    }
});

// Entrega index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`GG Player rodando com HTTPS na porta ${PORT}`);
});
