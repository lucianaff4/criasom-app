"""Generate a project-only certificate; never imports it into the OS/browser trust store."""
from pathlib import Path
from datetime import datetime, timedelta, timezone
import ipaddress
import sys
from cryptography import x509
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa

folder = Path(sys.argv[1]).resolve()
folder.mkdir(parents=True, exist_ok=True)
cert_path, key_path = folder / "tls-cert.pem", folder / "tls-key.pem"
if cert_path.exists() and key_path.exists():
    raise SystemExit(0)
if cert_path.exists() or key_path.exists():
    raise SystemExit("Incomplete local certificate pair; inspect before retrying.")
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Criasom synthetic loopback laboratory")])
now = datetime.now(timezone.utc)
cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=5))
        .not_valid_after(now + timedelta(days=7))
        .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(key, hashes.SHA256()))
key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
