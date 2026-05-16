import hashlib
import json
import os
import subprocess

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
from flask import Flask, Response, abort, g, jsonify, render_template, request, stream_with_context

load_dotenv()

app = Flask(__name__)

SCRAPER_PYTHON = os.path.expanduser('~/development/music-catalog/venv/bin/python')
SCRAPER_PATH = os.path.expanduser('~/development/music-catalog/scrape.py')
SCRAPER_CWD = os.path.expanduser('~/development/music-catalog')


def get_db():
    if 'db' not in g:
        g.db = psycopg2.connect(
            host=os.environ['DB_HOST'],
            port=os.environ.get('DB_PORT', 5432),
            dbname=os.environ['DB_NAME'],
            user=os.environ['DB_USER'],
            password=os.environ['DB_PASSWORD'],
        )
    return g.db


@app.teardown_appcontext
def close_db(error):
    db = g.pop('db', None)
    if db is not None:
        db.close()


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/genres')
def genres():
    cur = get_db().cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute('SELECT id, name FROM genres ORDER BY name')
    return jsonify(cur.fetchall())


@app.route('/api/albums')
def albums():
    page = max(1, int(request.args.get('page', 1)))
    per_page = 50
    offset = (page - 1) * per_page
    search = request.args.get('search', '').strip()
    genre_id = request.args.get('genre_id', '').strip()
    compilation = request.args.get('compilation', '').strip()
    sort = request.args.get('sort', 'artist').strip()

    sort_map = {
        'artist':   'ar.sort_name, a.year, a.title',
        'title':    'a.title, ar.sort_name',
        'year_desc':'a.year DESC NULLS LAST, ar.sort_name, a.title',
        'year_asc': 'a.year ASC NULLS LAST, ar.sort_name, a.title',
        'added':    'a.last_scraped DESC NULLS LAST, ar.sort_name, a.title',
    }
    order_by = sort_map.get(sort, sort_map['artist'])

    conditions = []
    params = []

    if search:
        conditions.append('(ar.name ILIKE %s OR a.title ILIKE %s)')
        like = f'%{search}%'
        params.extend([like, like])

    if genre_id:
        conditions.append(
            'EXISTS(SELECT 1 FROM album_genres ag WHERE ag.album_id = a.id AND ag.genre_id = %s)'
        )
        params.append(int(genre_id))

    if compilation == 'true':
        conditions.append('a.is_compilation = TRUE')

    where = ('WHERE ' + ' AND '.join(conditions)) if conditions else ''
    db = get_db()
    cur = db.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    cur.execute(
        f'SELECT COUNT(*) AS total FROM albums a JOIN artists ar ON ar.id = a.artist_id {where}',
        params,
    )
    total = cur.fetchone()['total']

    cur.execute(
        f"""
        SELECT
            a.id,
            a.title,
            ar.name  AS artist,
            a.year,
            f.name   AS format,
            a.is_compilation,
            EXISTS(
                SELECT 1 FROM tracks t
                WHERE t.album_id = a.id AND t.artwork IS NOT NULL
            ) AS has_artwork
        FROM albums a
        JOIN artists ar ON ar.id = a.artist_id
        JOIN formats  f  ON  f.id = a.format_id
        {where}
        ORDER BY {order_by}
        LIMIT %s OFFSET %s
        """,
        params + [per_page, offset],
    )

    return jsonify({'albums': cur.fetchall(), 'total': total, 'page': page, 'per_page': per_page})


@app.route('/api/albums/<int:album_id>')
def album_detail(album_id):
    db = get_db()
    cur = db.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    cur.execute(
        """
        SELECT
            a.id, a.title, ar.name AS artist, a.year, a.original_year,
            f.name AS format, a.label, a.catalog_number, a.disc_count,
            a.is_compilation,
            COALESCE(
                (SELECT STRING_AGG(g.name, ', ' ORDER BY g.name)
                 FROM album_genres ag JOIN genres g ON g.id = ag.genre_id
                 WHERE ag.album_id = a.id),
                ''
            ) AS genres
        FROM albums a
        JOIN artists ar ON ar.id = a.artist_id
        JOIN formats  f  ON  f.id = a.format_id
        WHERE a.id = %s
        """,
        (album_id,),
    )
    album = cur.fetchone()
    if not album:
        abort(404)

    cur.execute(
        """
        SELECT
            t.id, t.title, t.track_number, t.disc_number, t.duration_secs,
            t.composer, t.bit_depth, t.sample_rate,
            COALESCE(ar.name, '') AS artist
        FROM tracks t
        LEFT JOIN artists ar ON ar.id = t.artist_id
        WHERE t.album_id = %s
        ORDER BY t.disc_number, t.track_number, t.title
        """,
        (album_id,),
    )
    tracks = cur.fetchall()

    return jsonify({'album': dict(album), 'tracks': [dict(t) for t in tracks]})


@app.route('/api/artwork/<int:album_id>')
def artwork(album_id):
    db = get_db()
    cur = db.cursor()

    cur.execute('SELECT content_hash, last_scraped FROM albums WHERE id = %s', (album_id,))
    row = cur.fetchone()
    if not row:
        abort(404)

    etag_source = f'{album_id}:{row[0] or row[1]}'
    etag = '"' + hashlib.sha256(etag_source.encode()).hexdigest()[:24] + '"'

    if request.headers.get('If-None-Match') == etag:
        return Response(status=304)

    cur.execute(
        'SELECT artwork, artwork_mime FROM tracks WHERE album_id = %s AND artwork IS NOT NULL LIMIT 1',
        (album_id,),
    )
    row = cur.fetchone()
    if not row or not row[0]:
        abort(404)

    resp = Response(bytes(row[0]), content_type=row[1] or 'image/jpeg')
    resp.headers['ETag'] = etag
    resp.headers['Cache-Control'] = 'private, max-age=86400'
    return resp


@app.route('/api/scrape/<mode>')
def scrape(mode):
    if mode not in ('full', 'incremental'):
        abort(400)

    def generate():
        cmd = [SCRAPER_PYTHON, SCRAPER_PATH, '-v']
        if mode == 'full':
            cmd.append('--full')

        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                cwd=SCRAPER_CWD,
            )
            try:
                for line in proc.stdout:
                    yield f'data: {json.dumps(line.rstrip())}\n\n'
            finally:
                proc.wait()

            yield f'data: {json.dumps(f"[DONE] Exit code: {proc.returncode}")}\n\n'
        except Exception as exc:
            yield f'data: {json.dumps(f"[ERROR] {exc}")}\n\n'

        yield 'event: done\ndata: {}\n\n'

    return Response(
        stream_with_context(generate()),
        content_type='text/event-stream',
        headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'},
    )


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5001, debug=True, threaded=True)
