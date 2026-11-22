bucket         = "c-address-terraform-state"
key            = "staging/s3/terraform.tfstate"
region         = "us-east-1"
dynamodb_table = "terraform-locks"
encrypt        = true
