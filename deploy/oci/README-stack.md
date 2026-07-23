# OCI one-click (Resource Manager stack)

1. Zip the repo (or this `deploy/oci` + repo) and create an **OCI Resource Manager stack**
   (Console → Developer Services → Resource Manager → Stacks → Create).
2. Fill the variables (compartment, SSH key, subnet, Ubuntu aarch64 image OCID, callsign/passcode/
   filter, domain, ingest secret).
3. **Plan**, then **Apply**. cloud-init installs Docker and runs `docker compose up -d`.
4. Point DNS at the output `public_ip`. For Topology 3, put Cloudflare in front (see `cloudflare/`).

A "Deploy to Oracle Cloud" button (in your README) looks like:
`https://cloud.oracle.com/resourcemanager/stacks/create?zipUrl=<URL-to-your-stack-zip>`

Capacity tip: use **Frankfurt (eu-frankfurt-1)** for AT; retry if "out of host capacity".
