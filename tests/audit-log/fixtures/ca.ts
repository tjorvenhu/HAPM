/**
 * Ein selbst signiertes Zertifikat nur für Tests (CN=HAPM Test CA, 100 Jahre gültig).
 * Der Schlüssel dazu wurde nach dem Erzeugen verworfen: geprüft wird damit nur,
 * ob ein PEM gelesen und in Form gebracht wird.
 */
export const TEST_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIBhTCCASugAwIBAgIURUgI2GV0rJBJ2rCagQim/JZarSswCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMSEFQTSBUZXN0IENBMCAXDTI2MTEyNjE4MjEyMFoYDzIxMjYx
MTAyMTgyMTIwWjAXMRUwEwYDVQQDDAxIQVBNIFRlc3QgQ0EwWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAATyp2bZ2yBBZ4wwqbaojpb0eAsURdZnuD9JWuoiV3jzCCV8
KN8dsYLuw82eFIsKNliwHcBO0hTwvyJtVtXmmDF8o1MwUTAdBgNVHQ4EFgQUvCOh
UFBnDR0nVWgD3vk/pDoFFQMwHwYDVR0jBBgwFoAUvCOhUFBnDR0nVWgD3vk/pDoF
FQMwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiBVD/BqD+bBoTwj
viFH8O4vcdsLnrP0xZmqljyY7cyDGAIhAJUSk9d96r4X/Bfa9um5HZHlgdTlb6Xe
12Q6KWRbnBsL
-----END CERTIFICATE-----
`;
