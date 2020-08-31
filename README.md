# fck

F*CK: The Factorio Construction Kit

# Bootstrap

Ensure you have cdk and aws cli installed:
```
brew install awscli
npm install -g aws-cdk
```

Create an IAM user and configure credentials for aws cli.

```
aws configure --profile <PROFILE_NAME>
```

# Build

`npm run build`

# Deploy

`cdk deploy --profile <PROFILE_NAME>`

# SSHing to the host

Configure an AWS profile for the Server Admin user:

```
aws configure --profile <DIFFERENT_PROFILE_NAME>
```