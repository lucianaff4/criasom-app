<?php
declare(strict_types=1);
namespace Criasom;
use RuntimeException;

final class ResourceGate
{
    public static function allowed(?array $user, array $grants, array $object, int $now): bool
    {
        if (!$user || ($user['verified'] ?? false) !== true || !is_string($user['id'] ?? null)
            || !preg_match('/^[a-zA-Z0-9_-]{1,80}$/D', $user['id'])
            || !is_string($user['email'] ?? null) || !filter_var($user['email'], FILTER_VALIDATE_EMAIL)
            || ($object['status'] ?? '') !== 'active') return false;
        $email = strtolower($user['email']);
        $grants = array_values(array_filter($grants, static fn($g) => is_array($g) && ($g['email'] ?? null) === $email));
        $scopes = $object['required_scopes'] ?? [];
        if (!$scopes || !is_array($scopes)) return false;
        foreach ($scopes as $scope) if (!is_string($scope) || !AccessPolicy::allowed($grants, $scope, $now)) return false;
        return match ($object['visibility'] ?? '') {
            'course', 'community' => true,
            'self' => ($object['owner_id'] ?? null) === $user['id'],
            // assigned_teacher_ids is loaded by the server from object_teacher_access.
            'teacher' => ($object['owner_id'] ?? null) === $user['id'] || (is_array($object['assigned_teacher_ids'] ?? null) && in_array($user['id'], $object['assigned_teacher_ids'], true)),
            default => false,
        };
    }

    /** Only accept storage keys from the server manifest, never a URL/file name from the client. */
    public static function localPath(string $privateRoot, string $storageKey): string
    {
        if (!preg_match('/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,160}$/D', $storageKey) || str_contains($storageKey, '..')) throw new RuntimeException('Invalid storage key.');
        $root = realpath($privateRoot); $file = realpath($privateRoot . DIRECTORY_SEPARATOR . $storageKey);
        if (!$root || !$file || !is_file($file) || !str_starts_with($file, $root . DIRECTORY_SEPARATOR)) throw new RuntimeException('File unavailable.');
        return $file;
    }

    public static function headers(string $mime): array
    {
        if (!in_array($mime, ['application/pdf','image/png','image/jpeg','text/plain'], true)) throw new RuntimeException('Unsupported local resource type.');
        return ['Content-Type'=>$mime,'Content-Disposition'=>'inline','Cache-Control'=>'private, no-store','Vary'=>'Cookie','X-Content-Type-Options'=>'nosniff','Referrer-Policy'=>'no-referrer','Cross-Origin-Resource-Policy'=>'same-origin'];
    }
}
