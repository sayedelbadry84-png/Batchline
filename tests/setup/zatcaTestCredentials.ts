// A throwaway secp256k1 key and self-signed certificate, generated with
// openssl for tests only. They sign nothing real and are not a ZATCA CSID:
// the tests use them because signInvoiceXml needs a parseable certificate
// and a key on the curve ZATCA uses, and generating an X.509 certificate at
// test time would need openssl on every machine that runs the suite.
export const TEST_ONLY_PRIVATE_KEY_PEM = `-----BEGIN EC PRIVATE KEY-----
MHQCAQEEIKWKU+/uPX/am+ZgUQwC4xyteG2uwJqkh1szaba6ADvpoAcGBSuBBAAK
oUQDQgAEuZfOL67ODR2ZScTlR5U9fieM9q7AxQGpmTXoCexYD7ixmiVN3Nd5w198
4GfaQ5YrGSE7PZPTQ8NqR9o2TrZH8Q==
-----END EC PRIVATE KEY-----
`;

export const TEST_ONLY_CERTIFICATE_PEM = `-----BEGIN CERTIFICATE-----
MIIB6zCCAZKgAwIBAgIUJj2Q6O4VDR6PWsQ1Fp6D6bkEQG8wCgYIKoZIzj0EAwIw
TDELMAkGA1UEBhMCU0ExHzAdBgNVBAoMFkJhdGNobGluZSBUZXN0IEZpeHR1cmUx
HDAaBgNVBAMME2JhdGNobGluZS10ZXN0LW9ubHkwIBcNMjYwOTI2MTMzNzQxWhgP
MjEyNjA5MDIxMzM3NDFaMEwxCzAJBgNVBAYTAlNBMR8wHQYDVQQKDBZCYXRjaGxp
bmUgVGVzdCBGaXh0dXJlMRwwGgYDVQQDDBNiYXRjaGxpbmUtdGVzdC1vbmx5MFYw
EAYHKoZIzj0CAQYFK4EEAAoDQgAEuZfOL67ODR2ZScTlR5U9fieM9q7AxQGpmTXo
CexYD7ixmiVN3Nd5w1984GfaQ5YrGSE7PZPTQ8NqR9o2TrZH8aNTMFEwHQYDVR0O
BBYEFJLijS7pgvWQR23jBG580I4AVRoFMB8GA1UdIwQYMBaAFJLijS7pgvWQR23j
BG580I4AVRoFMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDRwAwRAIgbO/l
Amrqj9840k5ikHv1F3bJUYCiAS1+kugnHervObMCIHfthr2xo+Uq4+wB4Nqx/TxJ
mPhF6LLAYCZ1W52uLRCn
-----END CERTIFICATE-----
`;
