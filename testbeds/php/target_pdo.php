<?php
declare(strict_types=1);
/**
 * SQ-HotRoll Provider-Physics Native PHP PDO Target (`testbeds/php/target_pdo.php`)
 * Verifies: (1) PDO::ATTR_EMULATE_PREPARES = false view-swap / schema-change hazard vs
 * (2) SQ-HotRoll versioned PDO prepared handles ($stmt_v1, $stmt_v2) + bidirectional _lc triggers.
 */
$dbPath = $argv[1] ?? ':memory:';
$pdo = new PDO("sqlite:" . $dbPath, null, null, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    PDO::ATTR_EMULATE_PREPARES => false,
]);
$pdo->exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");

// 1. Reproduce naive view-swap / column-drop failure on cached PDO statement
$pdo->exec("CREATE TEMP TABLE php_v1 (id INTEGER PRIMARY KEY, full_name TEXT); INSERT INTO php_v1 VALUES (1, 'Linus Torvalds');");
$pdo->exec("CREATE TEMP TABLE php_v2 (id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT); INSERT INTO php_v2 VALUES (1, 'Linus', 'Torvalds');");
$pdo->exec("CREATE TEMP VIEW php_active AS SELECT id, full_name FROM php_v1;");
$naiveStmt = $pdo->prepare("SELECT id, full_name FROM php_active WHERE id = :id");
$naiveStmt->execute([':id' => 1]);
$naiveStmt->fetchAll();
$pdo->exec("DROP VIEW php_active; CREATE TEMP VIEW php_active AS SELECT id, first_name, last_name FROM php_v2;");
$naiveFailed = false;
try {
    $naiveStmt->execute([':id' => 1]);
    $naiveStmt->fetchAll();
} catch (PDOException $e) {
    $naiveFailed = true;
}

// 2. Verify SQ-HotRoll versioned PDO statements ($stmt_v1, $stmt_v2) + _lc preservation
$insV2 = $pdo->prepare(
    "INSERT INTO files_v2 (id, first_name, last_name, blob_sha256, byte_len, checksum_tag, _row_ver) " .
    "VALUES (303, 'Barbara', 'Liskov', '0123456789abcdef0123456789abcdef', 12288, 'sha256-php-verified', 1) " .
    "ON CONFLICT(id) DO UPDATE SET first_name=excluded.first_name, checksum_tag=excluded.checksum_tag, _row_ver=excluded._row_ver"
);
$insV2->execute();

$updV1 = $pdo->prepare(
    "INSERT INTO files_v1 (id, full_name, blob_sha256, byte_len, _row_ver, _lc) " .
    "VALUES (303, 'Prof Liskov', '0123456789abcdef0123456789abcdef', 12288, 2, " .
    "COALESCE((SELECT _lc FROM files_v1 WHERE id = 303), '{}')) " .
    "ON CONFLICT(id) DO UPDATE SET full_name=excluded.full_name, _row_ver=excluded._row_ver, _lc=excluded._lc"
);
$updV1->execute();

$stmtV1 = $pdo->prepare("SELECT full_name, _lc FROM files_v1 WHERE id = :id");
$stmtV2 = $pdo->prepare("SELECT first_name, last_name, checksum_tag, _row_ver FROM files_v2 WHERE id = :id");
$errors = 0;
for ($i = 0; $i < 20; $i++) {
    if (!$stmtV1->execute([':id' => 303]) || !$stmtV1->fetch()) $errors++;
    $stmtV1->closeCursor();
    if (!$stmtV2->execute([':id' => 303]) || !$stmtV2->fetch()) $errors++;
    $stmtV2->closeCursor();
}
$stmtV2->execute([':id' => 303]);
$row = $stmtV2->fetch();
$stmtV2->closeCursor();
$lcOk = ($row['first_name'] === 'Prof' && $row['last_name'] === 'Liskov' &&
         $row['checksum_tag'] === 'sha256-php-verified' && (int)$row['_row_ver'] === 2);

echo json_encode([
    'lang' => 'php',
    'driver' => 'pdo_sqlite-' . PHP_VERSION,
    'naive_view_swap_failed' => $naiveFailed,
    'hotroll_execs' => 40,
    'hotroll_errors' => $errors,
    'lc_preserved' => $lcOk,
]) . PHP_EOL;
exit(($naiveFailed && $errors === 0 && $lcOk) ? 0 : 1);
