<?php
// Blast Borough public leaderboard for the Daily Challenge (same arena for everyone each UTC day).
//   GET  ?date=YYYY-MM-DD&top=20    -> {"scores":[{name, score, won, kills, crates, seconds}, ...]}  that day's best
//   GET  ?all=1&top=20              -> {"scores":[{name, score, date, ...}]}                         best ever
//   POST name, date, won (0/1), kills, crates, pickups, seconds, score
//        -> {"ok":true,"rank":N,"best":bool} or {"ok":false,"error":"..."}
// The score is recalculated here from the round's stats (same formula as the game), so a typed-in
// score is rejected. One entry per name per day: only your best counts.

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, max-age=0');
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin === 'https://hosthobbit.github.io'
    || preg_match('#^http://(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$#', $origin)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    header('Vary: Origin');
}
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(204); exit; }

function out($data, $code = 200) { http_response_code($code); echo json_encode($data); exit; }
function fail($error, $code = 400) { out(['ok' => false, 'error' => $error], $code); }

$home = getenv('HOME') ?: dirname($_SERVER['DOCUMENT_ROOT'] ?? __DIR__);
$dataDir = getenv('BLAST_SIGNAL_DIR') ?: $home . '/game-scores';
if (!is_dir($dataDir) && !@mkdir($dataDir, 0700, true)) fail('storage unavailable', 500);
try {
    $db = new PDO('sqlite:' . $dataDir . '/blast-scores.sqlite');
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $db->exec('PRAGMA busy_timeout = 3000');
    $db->exec('CREATE TABLE IF NOT EXISTS daily (
        date TEXT NOT NULL, name TEXT NOT NULL, score INTEGER NOT NULL, won INTEGER NOT NULL, kills INTEGER NOT NULL,
        crates INTEGER NOT NULL, seconds INTEGER NOT NULL, created INTEGER NOT NULL, ip TEXT NOT NULL,
        PRIMARY KEY (date, name))');
    $db->exec('CREATE INDEX IF NOT EXISTS daily_rank ON daily (date, score DESC)');
    $db->exec('CREATE INDEX IF NOT EXISTS all_rank ON daily (score DESC)');
} catch (Exception $e) {
    fail('storage unavailable', 500);
}

function row_out($r, $withDate) {
    $o = ['name' => $r['name'], 'score' => (int)$r['score'], 'won' => (bool)$r['won'], 'kills' => (int)$r['kills'], 'crates' => (int)$r['crates'], 'seconds' => (int)$r['seconds']];
    if ($withDate) $o['date'] = $r['date'];
    return $o;
}

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $top = max(1, min(50, (int)($_GET['top'] ?? 20)));
    if (!empty($_GET['all'])) {
        $rows = $db->query("SELECT * FROM daily ORDER BY score DESC, created ASC LIMIT $top")->fetchAll(PDO::FETCH_ASSOC);
        out(['scores' => array_map(function ($r) { return row_out($r, true); }, $rows)]);
    }
    $date = $_GET['date'] ?? gmdate('Y-m-d');
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) fail('bad date');
    $q = $db->prepare("SELECT * FROM daily WHERE date = ? ORDER BY score DESC, created ASC LIMIT $top");
    $q->execute([$date]);
    out(['date' => $date, 'scores' => array_map(function ($r) { return row_out($r, false); }, $q->fetchAll(PDO::FETCH_ASSOC))]);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail('method not allowed', 405);

$in = $_POST;
if (!$in) { $j = json_decode(file_get_contents('php://input', false, null, 0, 4000) ?: '', true); if (is_array($j)) $in = $j; }
$int = function ($key, $min, $max) use ($in) {
    $v = filter_var($in[$key] ?? null, FILTER_VALIDATE_INT);
    if ($v === false || $v === null || $v < $min || $v > $max) fail("bad $key");
    return $v;
};
$won = $int('won', 0, 1);
$kills = $int('kills', 0, 3);            // three bots
$crates = $int('crates', 0, 200);
$pickups = $int('pickups', 0, 120);
$seconds = $int('seconds', 0, 126);       // a round can't last longer than this
$claimed = $int('score', 0, 1000000);

$date = $in['date'] ?? '';
if (!is_string($date) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) fail('bad date');
// today, or yesterday for rounds that finished just after midnight UTC
$today = gmdate('Y-m-d'); $yesterday = gmdate('Y-m-d', time() - 86400);
if ($date !== $today && $date !== $yesterday) fail('That challenge has closed.');

$name = trim(preg_replace('/\s+/u', ' ', (string)($in['name'] ?? '')));
if (!preg_match("/^[\\p{L}\\p{N} '._-]{2,16}$/u", $name)) fail('Names can be 2 to 16 letters or numbers.');
$squashed = strtolower(preg_replace('/[^a-z]/i', '', strtr($name, '013457@$', 'oieastas'))) . ' '
          . strtolower(preg_replace('/[^a-z]/i', '', strtr($name, '013457@$', 'oleastas')));
foreach (['fuck', 'shit', 'cunt', 'bitch', 'bastard', 'nigg', 'fag', 'twat', 'wank', 'piss', 'cock', 'dick', 'pussy', 'slut', 'whore', 'rape', 'nazi', 'hitler', 'retard', 'arse', 'asshole', 'bollock', 'spastic', 'paki', 'kkk'] as $bad) {
    if (strpos($squashed, $bad) !== false) fail('Please pick a different name.');
}

// same formula as dailyScore() in client/game/localMatch.ts
$score = $seconds * 3 + $crates * 4 + $pickups * 10 + $kills * 150 + ($won ? 500 + max(0, 120 - $seconds) * 4 : 0);
if ($score !== $claimed) fail('score mismatch');

$ip = hash('sha256', ($_SERVER['REMOTE_ADDR'] ?? '') . '|blast-scores');
$recent = $db->prepare('SELECT COUNT(*) FROM daily WHERE ip = ? AND created > ?');
$recent->execute([$ip, time() - 3600]);
if ((int)$recent->fetchColumn() >= 30) fail('Too many scores this hour, try again later.', 429);

$prev = $db->prepare('SELECT score FROM daily WHERE date = ? AND name = ?');
$prev->execute([$date, $name]);
$old = $prev->fetchColumn();
$best = $old === false || $score > (int)$old;
if ($best) {
    $db->prepare('INSERT OR REPLACE INTO daily (date, name, score, won, kills, crates, seconds, created, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
       ->execute([$date, $name, $score, $won, $kills, $crates, $seconds, time(), $ip]);
}
$mine = $best ? $score : (int)$old;
$rank = $db->prepare('SELECT COUNT(*) FROM daily WHERE date = ? AND score > ?');
$rank->execute([$date, $mine]);
out(['ok' => true, 'rank' => (int)$rank->fetchColumn() + 1, 'best' => $best, 'score' => $mine]);
