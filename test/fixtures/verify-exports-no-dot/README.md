# verify-exports-no-dot

A fixture whose `main` names a working module but whose `exports` map has no
`"."` entry, so importing the installed package by its bare name fails with
`ERR_PACKAGE_PATH_NOT_EXPORTED`.

## Requirements

- DeepSeek Harness `>=0.2.0`
