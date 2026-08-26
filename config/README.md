# Network configuration

The committed network catalog template is
[`networks.development.template.json`](./networks.development.template.json). Local deployment
commands copy and update that template as `networks.development.json`; the frontend and indexer
link to the generated file.

Deployment-specific `*_deploy_*.json` files are also generated locally and ignored. Keeping the
template under `config/` gives every package one stable root-level location for network
configuration without treating generated deployment state as source.

## Hiding a network from the directory

Factory-created networks remain on-chain, but a deployment can omit a test or superseded network
from the frontend's `/networks` directory by adding its ID to
[`hidden-network-ids.json`](./hidden-network-ids.json):

```json
[
  "0x01bf150f29820876f9007273dc505ef8a375cdbdc099913fd7ccd0d556c93a3a"
]
```

The ID is the value after `/networks/` in the network URL. IDs are matched case-insensitively and
must be 32-byte hex values. Redeploy the frontend after changing the list. This only removes the
listing; existing `/networks/<instance-id>` links remain reachable.
