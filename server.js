const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());

// Serve os arquivos do site (HTML, CSS, imagens) diretamente pela raiz HTTPS
app.use(express.static(path.join(__dirname, 'public')));

// Rota de proxy para os vídeos e APIs
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
            res.setHeader('Cache-Control', 'no-cache, no-store');
            return res.send(modified);
        }

        ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach(h => {
            const val = upstreamRes.headers.get(h);
            if (val) res.setHeader(h, val);
        });

        if (targetUrl.includes('.ts') || finalUrl.includes('.ts')) {
            res.setHeader('Content-Type', 'video/mp2t');
        }

        const arrayBuffer = await upstreamRes.arrayBuffer();
        res.send(Buffer.from(arrayBuffer));

    } catch (err) {
        res.status(502).json({ error: 'Falha no upstream', message: err.message });
    }
});

// Qualquer rota que não seja /proxy carrega o index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`GG Player rodando com HTTPS na porta ${PORT}`);
});
