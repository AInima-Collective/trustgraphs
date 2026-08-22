# Network configuration

The one committed configuration source file in this directory is
[`networks.development.template.json`](./networks.development.template.json). Local deployment
commands copy and update that template as `networks.development.json`; the frontend and indexer
link to the generated file.

Deployment-specific `*_deploy_*.json` files are also generated locally and ignored. Keeping the
template under `config/` gives every package one stable root-level location for network
configuration without treating generated deployment state as source.
