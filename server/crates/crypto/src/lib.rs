use std::time::{SystemTime, UNIX_EPOCH};

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, Generate, KeyInit, Payload, consts::U12},
};
use argon2::{
    Argon2,
    password_hash::{PasswordHasher as _, PasswordVerifier as _, phc::PasswordHash},
};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use rand::Rng as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;
use zeroize::Zeroizing;

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("secret must decode to exactly 32 bytes")]
    InvalidKeyLength,
    #[error("secret is not valid base64")]
    InvalidBase64,
    #[error("encryption failed")]
    Encryption,
    #[error("decryption failed")]
    Decryption,
    #[error("password hashing failed")]
    PasswordHash,
    #[error("password hash is invalid")]
    InvalidPasswordHash,
    #[error("JWT operation failed: {0}")]
    Jwt(#[from] jsonwebtoken::errors::Error),
    #[error("system clock is before the Unix epoch")]
    InvalidSystemClock,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EncryptedPayload {
    pub key_id: String,
    pub nonce: [u8; 12],
    pub ciphertext: Vec<u8>,
}

#[derive(Clone)]
pub struct EnvelopeCipher {
    key_id: String,
    cipher: Aes256Gcm,
}

impl EnvelopeCipher {
    pub fn from_base64(key_id: impl Into<String>, encoded_key: &str) -> Result<Self, CryptoError> {
        let key = decode_32_byte_secret(encoded_key)?;
        let cipher =
            Aes256Gcm::new_from_slice(key.as_slice()).map_err(|_| CryptoError::InvalidKeyLength)?;
        Ok(Self {
            key_id: key_id.into(),
            cipher,
        })
    }

    pub fn seal(&self, plaintext: &[u8], aad: &[u8]) -> Result<EncryptedPayload, CryptoError> {
        let nonce = Nonce::generate();
        let ciphertext = self
            .cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: plaintext,
                    aad,
                },
            )
            .map_err(|_| CryptoError::Encryption)?;
        Ok(EncryptedPayload {
            key_id: self.key_id.clone(),
            nonce: nonce.into(),
            ciphertext,
        })
    }

    pub fn open(&self, payload: &EncryptedPayload, aad: &[u8]) -> Result<Vec<u8>, CryptoError> {
        if payload.key_id != self.key_id {
            return Err(CryptoError::Decryption);
        }
        let nonce: Nonce<U12> = payload.nonce.into();
        self.cipher
            .decrypt(
                &nonce,
                Payload {
                    msg: &payload.ciphertext,
                    aad,
                },
            )
            .map_err(|_| CryptoError::Decryption)
    }
}

#[derive(Clone, Default)]
pub struct PasswordService;

impl PasswordService {
    pub fn hash(&self, password: &str) -> Result<String, CryptoError> {
        Argon2::default()
            .hash_password(password.as_bytes())
            .map(|hash| hash.to_string())
            .map_err(|_| CryptoError::PasswordHash)
    }

    pub fn verify(&self, password: &str, encoded_hash: &str) -> Result<bool, CryptoError> {
        let parsed =
            PasswordHash::new(encoded_hash).map_err(|_| CryptoError::InvalidPasswordHash)?;
        Ok(Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AccessClaims {
    pub sub: String,
    pub sid: String,
    pub iss: String,
    pub aud: String,
    pub iat: u64,
    pub exp: u64,
    pub jti: String,
}

#[derive(Clone)]
pub struct JwtIssuer {
    encoding_key: EncodingKey,
    decoding_key: DecodingKey,
    issuer: String,
    audience: String,
    access_ttl_seconds: u64,
}

impl JwtIssuer {
    pub fn from_base64(
        encoded_secret: &str,
        issuer: impl Into<String>,
        audience: impl Into<String>,
        access_ttl_seconds: u64,
    ) -> Result<Self, CryptoError> {
        let secret = decode_32_byte_secret(encoded_secret)?;
        Ok(Self {
            encoding_key: EncodingKey::from_secret(secret.as_slice()),
            decoding_key: DecodingKey::from_secret(secret.as_slice()),
            issuer: issuer.into(),
            audience: audience.into(),
            access_ttl_seconds,
        })
    }

    pub fn issue(
        &self,
        user_id: impl Into<String>,
        session_id: impl Into<String>,
    ) -> Result<(String, AccessClaims), CryptoError> {
        let issued_at = unix_timestamp()?;
        let claims = AccessClaims {
            sub: user_id.into(),
            sid: session_id.into(),
            iss: self.issuer.clone(),
            aud: self.audience.clone(),
            iat: issued_at,
            exp: issued_at.saturating_add(self.access_ttl_seconds),
            jti: Uuid::new_v4().to_string(),
        };
        let token = encode(&Header::new(Algorithm::HS256), &claims, &self.encoding_key)?;
        Ok((token, claims))
    }

    pub fn verify(&self, token: &str) -> Result<AccessClaims, CryptoError> {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.set_issuer(&[&self.issuer]);
        validation.set_audience(&[&self.audience]);
        Ok(decode::<AccessClaims>(token, &self.decoding_key, &validation)?.claims)
    }
}

pub fn issue_refresh_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn hash_refresh_token(token: &str, pepper: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(pepper);
    hasher.update([0]);
    hasher.update(token.as_bytes());
    hasher.finalize().into()
}

pub fn decode_32_byte_secret(encoded: &str) -> Result<Zeroizing<Vec<u8>>, CryptoError> {
    let decoded = STANDARD
        .decode(encoded)
        .map_err(|_| CryptoError::InvalidBase64)?;
    if decoded.len() != 32 {
        return Err(CryptoError::InvalidKeyLength);
    }
    Ok(Zeroizing::new(decoded))
}

fn unix_timestamp() -> Result<u64, CryptoError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .map_err(|_| CryptoError::InvalidSystemClock)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> String {
        STANDARD.encode([7_u8; 32])
    }

    #[test]
    fn encryption_authenticates_associated_data() {
        let cipher = EnvelopeCipher::from_base64("test-v1", &test_key()).unwrap();
        let payload = cipher.seal(b"secret", b"document-a").unwrap();

        assert_eq!(cipher.open(&payload, b"document-a").unwrap(), b"secret");
        assert!(cipher.open(&payload, b"document-b").is_err());
    }

    #[test]
    fn passwords_are_not_stored_verbatim() {
        let service = PasswordService;
        let hash = service.hash("correct horse battery staple").unwrap();

        assert!(!hash.contains("correct horse"));
        assert!(
            service
                .verify("correct horse battery staple", &hash)
                .unwrap()
        );
        assert!(!service.verify("wrong", &hash).unwrap());
    }

    #[test]
    fn jwt_round_trips_and_validates() {
        let issuer = JwtIssuer::from_base64(&test_key(), "wudang", "desktop", 60).unwrap();
        let (token, issued) = issuer.issue("user-1", "session-1").unwrap();
        let verified = issuer.verify(&token).unwrap();

        assert_eq!(verified.sub, issued.sub);
        assert_eq!(verified.sid, "session-1");
    }
}
