<?php
// Blast Borough peer-to-peer introductions ("signalling").
//
// In online play the room host's browser runs the game, and friends connect to it directly over
// WebRTC. Browsers can't find each other on their own, so this script passes a few small
// connection messages between them when someone joins. No gameplay goes through here.
//
// POST JSON {action, ...}:
//   host                          -> {code, secret}                 open a room
//   join   {code}                 -> {peer, secret}                 ask to join a room
//   send   {code, me, secret, to, body}                             message "host" or a peer id
//   poll   {code, me, secret}     -> {messages:[{from, body}]}      collect messages (host poll = heartbeat)
//   close  {code, me, secret}                                       host closes the room
// Rooms vanish 2 minutes after the host stops polling. Messages expire after 2 minutes.

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, max-age=0');
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin === 'https://hosthobbit.github.io'
    || preg_match('#^http://(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$#', $origin)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Access-Control-Allow-Methods: POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    header('Access-Control-Max-Age: 86400');
    header('Vary: Origin');
}
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

function out($data, $code = 200) { http_response_code($code); echo json_encode($data); exit; }
function fail($error, $code = 400) { out(['ok' => false, 'error' => $error], $code); }

if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail('method not allowed', 405);
$raw = file_get_contents('php://input', false, null, 0, 24000);
$req = json_decode($raw ?: '', true);
if (!is_array($req) || !isset($req['action']) || !is_string($req['action'])) fail('bad request');

$home = getenv('HOME') ?: dirname($_SERVER['DOCUMENT_ROOT'] ?? __DIR__);
$dataDir = getenv('BLAST_SIGNAL_DIR') ?: $home . '/game-scores';
if (!is_dir($dataDir) && !@mkdir($dataDir, 0700, true)) fail('storage unavailable', 500);

try {
    $db = new PDO('sqlite:' . $dataDir . '/blast-signal.sqlite');
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $db->exec('PRAGMA busy_timeout = 3000');
    $db->exec('PRAGMA journal_mode = WAL');
    $db->exec('CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, secret TEXT NOT NULL, seen INTEGER NOT NULL)');
    $db->exec('CREATE TABLE IF NOT EXISTS peers (id TEXT PRIMARY KEY, code TEXT NOT NULL, secret TEXT NOT NULL, created INTEGER NOT NULL)');
    $db->exec('CREATE TABLE IF NOT EXISTS msgs (id INTEGER PRIMARY KEY, code TEXT NOT NULL, dest TEXT NOT NULL, src TEXT NOT NULL, body TEXT NOT NULL, created INTEGER NOT NULL)');
    $db->exec('CREATE INDEX IF NOT EXISTS msgs_dest ON msgs (code, dest)');
    $db->exec('CREATE TABLE IF NOT EXISTS hits (ip TEXT NOT NULL, minute INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (ip, minute))');
} catch (Exception $e) {
    fail('storage unavailable', 500);
}

$now = time();
// tidy up (cheap: small tables)
$db->prepare('DELETE FROM rooms WHERE seen < ?')->execute([$now - 120]);
$db->prepare('DELETE FROM msgs WHERE created < ?')->execute([$now - 120]);
$db->prepare('DELETE FROM peers WHERE created < ? OR code NOT IN (SELECT code FROM rooms)')->execute([$now - 3600]);
$db->prepare('DELETE FROM hits WHERE minute < ?')->execute([intdiv($now, 60) - 2]);

// rate limit: polling once a second is fine; floods are not
$ip = hash('sha256', ($_SERVER['REMOTE_ADDR'] ?? '') . '|blast-signal');
$minute = intdiv($now, 60);
$db->prepare('INSERT INTO hits (ip, minute, n) VALUES (?, ?, 1) ON CONFLICT(ip, minute) DO UPDATE SET n = n + 1')->execute([$ip, $minute]);
$hits = $db->prepare('SELECT n FROM hits WHERE ip = ? AND minute = ?');
$hits->execute([$ip, $minute]);
if ((int)$hits->fetchColumn() > 400) fail('slow down', 429);

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function token($n) { return bin2hex(random_bytes($n)); }
function str_field($req, $key, $max) {
    $v = $req[$key] ?? null;
    if (!is_string($v) || $v === '' || strlen($v) > $max) fail("bad $key");
    return $v;
}

/** Check that `me` (host or a peer id) holds `secret` for room `code`. */
function auth($db, $code, $me, $secret) {
    if ($me === 'host') {
        $q = $db->prepare('SELECT secret FROM rooms WHERE code = ?');
        $q->execute([$code]);
    } else {
        $q = $db->prepare('SELECT secret FROM peers WHERE id = ? AND code = ?');
        $q->execute([$me, $code]);
    }
    $s = $q->fetchColumn();
    if ($s === false) fail('room_not_found', 404);
    if (!hash_equals($s, $secret)) fail('forbidden', 403);
}

switch ($req['action']) {
    case 'host': {
        for ($i = 0; $i < 50; $i++) {
            $code = '';
            for ($k = 0; $k < 5; $k++) $code .= ALPHABET[random_int(0, strlen(ALPHABET) - 1)];
            $q = $db->prepare('SELECT 1 FROM rooms WHERE code = ?');
            $q->execute([$code]);
            if ($q->fetchColumn() === false) break;
        }
        $count = (int)$db->query('SELECT COUNT(*) FROM rooms')->fetchColumn();
        if ($count > 500) fail('busy', 503);
        $secret = token(16);
        $db->prepare('INSERT INTO rooms (code, secret, seen) VALUES (?, ?, ?)')->execute([$code, $secret, $now]);
        out(['ok' => true, 'code' => $code, 'secret' => $secret]);
    }
    case 'join': {
        $code = strtoupper(str_field($req, 'code', 5));
        if (!preg_match('/^[A-Z2-9]{5}$/', $code)) fail('bad code');
        $q = $db->prepare('SELECT 1 FROM rooms WHERE code = ?');
        $q->execute([$code]);
        if ($q->fetchColumn() === false) fail('room_not_found', 404);
        $peers = $db->prepare('SELECT COUNT(*) FROM peers WHERE code = ?');
        $peers->execute([$code]);
        if ((int)$peers->fetchColumn() > 40) fail('busy', 503);
        $id = token(6);
        $secret = token(16);
        $db->prepare('INSERT INTO peers (id, code, secret, created) VALUES (?, ?, ?, ?)')->execute([$id, $code, $secret, $now]);
        out(['ok' => true, 'peer' => $id, 'secret' => $secret]);
    }
    case 'send': {
        $code = str_field($req, 'code', 5);
        $me = str_field($req, 'me', 32);
        auth($db, $code, $me, str_field($req, 'secret', 64));
        $to = str_field($req, 'to', 32);
        if ($me !== 'host' && $to !== 'host') fail('peers can only message the host');
        $body = str_field($req, 'body', 20000);
        $pending = $db->prepare('SELECT COUNT(*) FROM msgs WHERE code = ? AND dest = ?');
        $pending->execute([$code, $to]);
        if ((int)$pending->fetchColumn() > 60) fail('busy', 503);
        $db->prepare('INSERT INTO msgs (code, dest, src, body, created) VALUES (?, ?, ?, ?, ?)')->execute([$code, $to, $me, $body, $now]);
        out(['ok' => true]);
    }
    case 'poll': {
        $code = str_field($req, 'code', 5);
        $me = str_field($req, 'me', 32);
        auth($db, $code, $me, str_field($req, 'secret', 64));
        if ($me === 'host') $db->prepare('UPDATE rooms SET seen = ? WHERE code = ?')->execute([$now, $code]);
        $db->beginTransaction();
        $q = $db->prepare('SELECT id, src, body FROM msgs WHERE code = ? AND dest = ? ORDER BY id LIMIT 20');
        $q->execute([$code, $me]);
        $rows = $q->fetchAll(PDO::FETCH_ASSOC);
        if ($rows) {
            $ids = implode(',', array_map(function ($r) { return (int)$r['id']; }, $rows));
            $db->exec("DELETE FROM msgs WHERE id IN ($ids)");
        }
        $db->commit();
        out(['ok' => true, 'messages' => array_map(function ($r) { return ['from' => $r['src'], 'body' => $r['body']]; }, $rows)]);
    }
    case 'close': {
        $code = str_field($req, 'code', 5);
        auth($db, $code, 'host', str_field($req, 'secret', 64));
        $db->prepare('DELETE FROM rooms WHERE code = ?')->execute([$code]);
        $db->prepare('DELETE FROM msgs WHERE code = ?')->execute([$code]);
        $db->prepare('DELETE FROM peers WHERE code = ?')->execute([$code]);
        out(['ok' => true]);
    }
    default:
        fail('unknown action');
}
