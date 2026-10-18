<?php
declare(strict_types=1);
namespace Criasom;

/** Internal PHP boundary. Implementations never receive a browser-supplied user identity. */
interface PlatformBackend
{
    public function takeQuota(string $scope, string $bucket, int $limit, int $windowSeconds, int $now): bool;
    public function session(string $token, int $now): ?array;
    public function requestCode(string $email, string $binding, string $bucket, int $now): array;
    public function confirmCode(string $challengeId, string $code, string $binding, int $now): ?array;
    public function logout(string $token, string $csrf, int $now): bool;
    public function capabilities(array $user, int $now): array;
    /** Areas: study, repertoire, preferences. Ownership and entitlement are enforced here too. */
    public function getState(array $user, string $area, int $now): array;
    public function saveState(array $user, string $area, int $expectedRevision, array|\stdClass $data, int $now): array;
    /** null means absent OR denied; return only authorized bytes and allowlisted MIME. */
    public function resource(array $user, string $id, int $now): ?array;
    /** Receives only an authenticated, normalized envelope. Policies come from server configuration. */
    public function purchase(array $event, int $now): array;
}

final class PlatformProblem extends \RuntimeException
{
    public function __construct(public readonly int $status, public readonly string $errorId)
    {
        parent::__construct($errorId);
    }
}
