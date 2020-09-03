import { InstanceType, Port, SubnetType, Vpc } from "monocdk-experiment/aws-ec2";
import { Aws, Construct, RemovalPolicy, Tags } from "monocdk-experiment";
import {
  Cluster,
  ContainerImage,
  Ec2Service,
  Ec2TaskDefinition,
  EcsOptimizedImage,
  LogDrivers,
  Protocol,
  Volume,
} from "monocdk-experiment/aws-ecs";
import { FileSystem } from "monocdk-experiment/aws-efs";
import { Effect, Policy, PolicyStatement } from "monocdk-experiment/aws-iam";
import { AutoScalingGroup } from "monocdk-experiment/aws-autoscaling";
import { RetentionDays } from "monocdk-experiment/aws-logs";

export interface AddAutoServerClusterOptions {
  readonly instanceType: InstanceType;

  // Sets the maximum price (in USD / hour) paid for spot instances in this group.  If undefined, on-demand instances
  // are used.
  // Default: undefined
  spotPrice?: number;

  // The minimum capacity to keep in this ASG.
  // Default: 0
  minCapacity?: number;

  // The maximum capacity to keep in this AGS.
  // Default: 1
  maxCapacity?: number;
}

export interface AutoServerClusterProps extends AddAutoServerClusterOptions {
  // The VPC that resources in this cluster run in.
  readonly vpc: Vpc;
}

// An AutoServerCluster is an ECS cluster of EC2 instances that can host multiple Factorio servers.
// Servers in this cluster share an EFS volume, which is mounted to every instance in the Auto Scaling Group.  This
// allows an admin to connect to any instance to adminster the server.
//
// Servers must each have a unique port and RCON port (if used).
//
// Inspired by (stolen from): https://github.com/m-chandler/factorio-spot-pricing/
export class AutoServerCluster extends Construct {
  readonly cluster: Cluster;
  readonly autoScalingGroup: AutoScalingGroup;
  readonly fileSystem: FileSystem;

  private servers = new Array<AutoServer>();

  constructor(scope: Construct, id: string, props: AutoServerClusterProps) {
    super(scope, id);

    this.cluster = new Cluster(this, "Cluster", {
      vpc: props.vpc,
    });

    this.autoScalingGroup = this.constructAutoScalingGroup(props);
    this.fileSystem = this.constructFileSystem(props);
  }

  private constructAutoScalingGroup(props: AutoServerClusterProps) {
    return this.cluster.addCapacity("ASG", {
      instanceType: props.instanceType,
      machineImage: EcsOptimizedImage.amazonLinux2(),
      associatePublicIpAddress: true,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      minCapacity: props?.minCapacity || 0,
      maxCapacity: props?.maxCapacity || 1,
      spotPrice: props?.spotPrice?.toString(),
    });
  }

  private constructFileSystem(props: AutoServerClusterProps) {
    const fileSystem = new FileSystem(this, "FileSystem", {
      vpc: props.vpc,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // 2049 is the NFS port, so this grants the instances in the ASG the ability to mount the EFS filesystem.
    this.autoScalingGroup.connections.allowTo(fileSystem, Port.tcp(2049), "Allow EFS");

    // Mounts the EFS filesystem to /opt/factorio
    this.autoScalingGroup.userData.addCommands(
      "yum install -y amazon-efs-utils", // This is installed by default on AL2 but it doesn't hurt.
      "mkdir -p /opt/factorio",
      `mount -t efs ${fileSystem.fileSystemId}:/ /opt/factorio`,
      "chown 845:845 /opt/factorio", // TODO: What is this magical 845 user?
    );

    return fileSystem;
  }

  // Configures the ASG to accept SSH connections with EC2 Instance Connect, and returns a policy that can be attached
  // to an IIdentity to allow access to the servers.
  public configureInstanceConnect() {
    Tags.of(this).add("fck:cluster", this.node.uniqueId, {
      applyToLaunchedInstances: true,
    });

    const allowDescribeInstances = new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["ec2:DescribeInstances"],
      resources: ["*"],
    });

    const allowInstanceConnect = new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ["ec2-instance-connect:SendSSHPublicKey"],
      resources: [`arn:aws:ec2:${Aws.REGION}:${Aws.ACCOUNT_ID}:instance/*`],
      conditions: {
        StringEquals: {
          "aws:ResourceTag/fck:cluster": this.node.uniqueId,
        },
      },
    });

    this.autoScalingGroup.connections.allowFromAnyIpv4(Port.tcp(22), "Allow SSH");

    // This should be installed by default on Amazon Linux 2, but it doesn't hurt.
    this.autoScalingGroup.userData.addCommands("sudo yum install ec2-instance-connect");

    return new Policy(this, "Admin", {
      statements: [allowDescribeInstances, allowInstanceConnect],
    });
  }

  public addServer(id: string, options: AutoServerOptions): AutoServer {
    const server = new AutoServer(this, id, {
      cluster: this.cluster,
      fileSystem: this.fileSystem,
      ...options,
    });

    this.servers.push(server);
    return server;
  }

  protected prepare(): void {
    this.servers.forEach((server) => {
      // Ensure all our capacity gets added _before_ we start adding tasks.
      server.service.node.addDependency(this.autoScalingGroup);

      // Ensure that each server is accessible from the internet.
      this.autoScalingGroup.connections.allowFromAnyIpv4(Port.udp(server.serverPort), "Allow Factorio Server");
      this.autoScalingGroup.connections.allowFromAnyIpv4(Port.tcp(server.rconPort), "Allow RCON");
    });
  }
}

export interface AutoServerOptions {
  // The number of vCPUs to reserve for this server.  Must be <= the number of vCPUs in the instance type selected.
  readonly cpu: number;

  // The amount of memory to reserved for this server;
  readonly memoryReservationMiB: number;

  // The factorio image to use from: https://hub.docker.com/r/factoriotools/factorio/
  // Default: stable
  readonly imageTag?: string;

  // The port the Factorio server listens on.
  // Default: 34197
  readonly serverPort?: number;

  // Default: 27015
  readonly rconPort?: number;
}

interface AutoServerProps extends AutoServerOptions {
  readonly cluster: Cluster;
  readonly fileSystem: FileSystem;
}

export class AutoServer extends Construct {
  readonly imageTag: string;
  readonly serverPort: number;
  readonly rconPort: number;

  readonly service: Ec2Service;

  constructor(scope: Construct, id: string, props: AutoServerProps) {
    super(scope, id);

    this.imageTag = props.imageTag || "stable";
    this.serverPort = props.serverPort || 34197;
    this.rconPort = props.rconPort || 27015;

    // Every server
    const volume: Volume = {
      name: "FactorioVolume",
      host: {
        sourcePath: `/opt/factorio/${id}`,
      },
    };

    const taskDefinition = new Ec2TaskDefinition(this, "TaskDef", {
      volumes: [volume],
    });

    const container = taskDefinition.addContainer("Container", {
      cpu: props.cpu,
      memoryReservationMiB: props.memoryReservationMiB,
      image: ContainerImage.fromRegistry(`factoriotools/factorio:${this.imageTag}`),
      logging: LogDrivers.awsLogs({
        streamPrefix: id,
        logRetention: RetentionDays.ONE_MONTH,
      }),
    });

    container.addPortMappings(
      { containerPort: this.serverPort, hostPort: 34197, protocol: Protocol.UDP },
      { containerPort: this.rconPort, hostPort: 27015, protocol: Protocol.TCP },
    );

    container.addMountPoints({
      containerPath: "/factorio",
      sourceVolume: volume.name,
      readOnly: false,
    });

    this.service = new Ec2Service(this, "Service", {
      cluster: props.cluster,
      taskDefinition: taskDefinition,
      desiredCount: 1,
      maxHealthyPercent: 100,
      minHealthyPercent: 0,
    });
  }
}
