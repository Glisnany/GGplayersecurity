const express = require('express');
const cors = require('cors');
const path = require('path');
const { Readable } = require('stream');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.disable('etag');

// Serve arquivos estáticos da raiz
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

        // Repasse de Range para permitir Seek em Filmes e Séries (VOD)
        if (req.headers.range) {
            upstreamHeaders['Range'] = req.headers.range;
        }

        const upstreamRes = await fetch(targetUrl, {
            headers: upstreamHeaders,
            redirect: 'follow'
        });

        // Repassa status 200, 206 (Partial Content) ou erros
        res.status(upstreamRes.status);

        const finalUrl = upstreamRes.url || targetUrl;
        const contentType = (upstreamRes.headers.get('content-type') || '').toLowerCase();

        // 1. Processamento de Playlist HLS (.m3u8) apenas para canais/streams HLS
        if (contentType.includes('mpegurl') || targetUrl.toLowerCase().includes('.m3u8') || finalUrl.toLowerCase().includes('.m3u8')) {
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

        // 2. Transmissão Progressiva para Vídeos (VOD .mp4 / .mkv / .ts) e Imagens
        ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach(h => {
            const val = upstreamRes.headers.get(h);
            if (val) res.setHeader(h, val);
        });

        if (!upstreamRes.headers.get('accept-ranges')) {
            res.setHeader('Accept-Ranges', 'bytes');
        }

        if (targetUrl.includes('.ts') || finalUrl.includes('.ts')) {
            res.setHeader('Content-Type', 'video/mp2t');
            res.setHeader('Cache-Control', 'public, max-age=3600');
        }

        if (upstreamRes.body) {
            const nodeStream = Readable.fromWeb(upstreamRes.body);
            nodeStream.on('error', () => {});
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

// Entrega index.html na raiz
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`GG Player rodando com HTTPS na porta ${PORT}`);
});
