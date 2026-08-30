terraform {
  required_version = ">= 1.6"

  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 6.0"
    }
  }
}

provider "oci" {
  tenancy_ocid     = var.tenancy_ocid
  user_ocid        = var.user_ocid
  fingerprint      = var.fingerprint
  private_key_path = var.private_key_path
  region           = var.region
}

resource "oci_core_vcn" "pewter" {
  compartment_id = var.tenancy_ocid
  # Live VCN CIDR and DNS label; these are fixed because NixOS and the
  # instance network configuration depend on them.
  cidr_block   = "10.0.0.0/16"
  display_name = "vcn-20260703-2137"
  dns_label    = "vcn07032154"

  lifecycle {
    prevent_destroy = true
  }
}

resource "oci_core_internet_gateway" "pewter" {
  compartment_id = var.tenancy_ocid
  vcn_id         = oci_core_vcn.pewter.id
  display_name   = "Internet Gateway vcn-20260703-2137"
  enabled        = true

  lifecycle {
    prevent_destroy = true
  }
}

resource "oci_core_route_table" "pewter" {
  compartment_id = var.tenancy_ocid
  vcn_id         = oci_core_vcn.pewter.id
  display_name   = "Default Route Table for vcn-20260703-2137"

  route_rules {
    # The only live route: public traffic exits through the internet gateway.
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.pewter.id
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "oci_core_security_list" "pewter" {
  compartment_id = var.tenancy_ocid
  vcn_id         = oci_core_vcn.pewter.id
  display_name   = "Default Security List for vcn-20260703-2137"

  egress_security_rules {
    # Preserve the live default egress rule.
    destination = "0.0.0.0/0"
    protocol    = "all"
  }

  ingress_security_rules {
    # ICMP fragmentation-needed traffic from the public internet.
    source   = "0.0.0.0/0"
    protocol = "1"
    icmp_options {
      type = 3
      code = 4
    }
  }

  ingress_security_rules {
    # ICMP traffic within the VCN CIDR.
    source   = "10.0.0.0/16"
    protocol = "1"
    icmp_options {
      type = 3
    }
  }

  ingress_security_rules {
    # Preserve the live stateless rule; network behavior changes need a
    # matching stateless egress rule and a separate reviewed plan.
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"
    protocol    = "6"
    stateless   = true
    description = "attic"
    tcp_options {
      min = 80
      max = 80
    }
  }

  ingress_security_rules {
    # Preserve the live stateless HTTPS rule.
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"
    protocol    = "6"
    stateless   = true
    description = "attic"
    tcp_options {
      min = 443
      max = 443
    }
  }

  ingress_security_rules {
    # Preserve the live stateless SSH rule used by pewter.
    source      = "0.0.0.0/0"
    source_type = "CIDR_BLOCK"
    protocol    = "6"
    stateless   = true
    description = "ssh"
    tcp_options {
      min = 2222
      max = 2222
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "oci_core_dhcp_options" "pewter" {
  compartment_id = var.tenancy_ocid
  vcn_id         = oci_core_vcn.pewter.id
  display_name   = "Default DHCP Options for vcn-20260703-2137"

  options {
    # OCI's VCN-local resolver plus public DNS resolution.
    type        = "DomainNameServer"
    server_type = "VcnLocalPlusInternet"
  }

  options {
    # OCI-generated search domain for this VCN.
    type                = "SearchDomain"
    search_domain_names = ["vcn07032154.oraclevcn.com"]
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "oci_core_subnet" "pewter" {
  compartment_id = var.tenancy_ocid
  vcn_id         = oci_core_vcn.pewter.id
  # Live subnet CIDR; this is the subnet assigned to pewter's primary VNIC.
  cidr_block                 = "10.0.0.0/24"
  display_name               = "subnet-20260703-2137"
  dns_label                  = "subnet07032154"
  route_table_id             = oci_core_route_table.pewter.id
  security_list_ids          = [oci_core_security_list.pewter.id]
  dhcp_options_id            = oci_core_dhcp_options.pewter.id
  prohibit_public_ip_on_vnic = false

  lifecycle {
    prevent_destroy = true
  }
}

resource "oci_core_boot_volume" "pewter" {
  # PHX availability domain containing the existing pewter resources.
  availability_domain = "kacn:PHX-AD-1"
  compartment_id      = var.tenancy_ocid
  display_name        = "pewter (Boot Volume)"
  size_in_gbs         = 200
  vpus_per_gb         = 10

  source_details {
    # Required by the provider schema; ignored after import because this is
    # an existing volume rather than a volume created from a source.
    type = "bootVolume"
    id   = "ocid1.bootvolume.oc1.phx.abyhqljsajk4qdvop4m73vcqshqkskm626tkeunyo6npto4fgihqduef2oja"
  }

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [source_details]
  }
}

resource "oci_core_instance" "pewter" {
  # PHX availability domain containing the existing pewter resources.
  availability_domain = "kacn:PHX-AD-1"
  compartment_id      = var.tenancy_ocid
  display_name        = "pewter"
  shape               = "VM.Standard.A1.Flex"

  shape_config {
    ocpus         = 2
    memory_in_gbs = 12
  }

  create_vnic_details {
    assign_public_ip       = true
    hostname_label         = "pewter"
    skip_source_dest_check = false
    subnet_id              = oci_core_subnet.pewter.id
  }

  metadata = {
    # Existing administrator key; changing it would affect console recovery.
    ssh_authorized_keys = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIyaPm21KDiQAXbzoG0IS7KO8rwcrP2ZqwJjW6uvh29A wovw@gram"
  }

  source_details {
    # Original OCI image reference. NixOS owns the guest OS after migration.
    source_type = "image"
    source_id   = "ocid1.image.oc1.phx.aaaaaaaalqn2ic3lq72og25xyd3wztmaeixmer34qvci5xtvaorgd6onqrsq"
  }

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [source_details]
  }
}

resource "oci_core_public_ip" "pewter" {
  compartment_id = var.tenancy_ocid
  lifetime       = "EPHEMERAL"
  # Existing private IP attachment; OCI manages the ephemeral public address.
  private_ip_id = "ocid1.privateip.oc1.phx.abyhqljs4gbp4visd6nzhdg2xysbkb5lof63nyutlccr6xgznxyxuru2enrq"
  display_name  = "publicip20260704182514"

  lifecycle {
    prevent_destroy = true
  }
}

resource "oci_budget_budget" "pewter" {
  # Keep the free-tier spending guard at one dollar per month.
  amount                 = 1
  compartment_id         = var.tenancy_ocid
  display_name           = "free-milk"
  description            = "make sure free instance stays free"
  processing_period_type = "MONTH"
  reset_period           = "MONTHLY"
  target_type            = "COMPARTMENT"
  targets                = [var.tenancy_ocid]

  lifecycle {
    prevent_destroy = true
  }
}

resource "oci_budget_alert_rule" "pewter" {
  budget_id  = oci_budget_budget.pewter.id
  recipients = var.budget_alert_email
  # Alert when actual spend reaches the budget limit.
  threshold      = 100
  threshold_type = "PERCENTAGE"
  type           = "ACTUAL"

  lifecycle {
    prevent_destroy = true
  }
}
