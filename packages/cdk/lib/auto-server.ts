import { Aws, Construct, RemovalPolicy, Tags } from "monocdk-experiment";
import { InstanceType, Port, SubnetType, Vpc } from "monocdk-experiment/aws-ec2";
import { FileSystem } from "monocdk-experiment/aws-efs";
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
import { AutoScalingGroup, Schedule, ScheduledAction } from "monocdk-experiment/aws-autoscaling";
import { RetentionDays } from "monocdk-experiment/aws-logs";
import { Effect, IIdentity, ManagedPolicy, PolicyStatement } from "monocdk-experiment/aws-iam";

export interface AutoServerClusterProps {
  readonly vpc: Vpc;
}

export interface SpotCapacityOptions {
  readonly instanceType: InstanceType;
  spotPrice: string;
  minCapacity?: 0;
  maxCapacity?: 1;
}

export interface AutoServerOptions {
  // The number of vCPUs to reserve for this server.  Must be <= the number of vCPUs in the instance type selected.
  readonly cpu: number;

  // The amount of memory to reserver for this server;
  readonly memoryReservationMiB: number;

  // The factorio image to use from: https://hub.docker.com/r/factoriotools/factorio/
  // Default: stable
  readonly imageTag?: string;

  // The port to run the factorio server on
  // Default:
  readonly serverPort?: number;
  readonly rconPort?: number;
}

// An AutoServerCluster is an ECS cluster of EC2 instances that can host multiple factorio servers.
export class AutoServerCluster extends Construct {
  readonly cluster: Cluster;
  readonly fileSystem: FileSystem;
  readonly adminManagedPolicy: ManagedPolicy;

  private autoScalingGroups = new Array<AutoScalingGroup>();
  private servers = new Array<AutoServer>();

  constructor(scope: Construct, id: string, props: AutoServerClusterProps) {
    super(scope, id);

    this.cluster = new Cluster(this, "Cluster", {
      vpc: props.vpc,
    });

    this.fileSystem = new FileSystem(this, "FileSystem", {
      vpc: props.vpc,
      removalPolicy: RemovalPolicy.RETAIN,
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

    this.adminManagedPolicy = new ManagedPolicy(this, "Admin", {
      description: "Allows ec2-connect-instance to servers in the specified AutoServerCluster.",
      statements: [allowDescribeInstances, allowInstanceConnect],
    });
  }

  // Adds spot instance capacity to the cluster.  Spot instances are terminated if the configured maximum price is
  // exceeded.
  public addSpotCapacity(id: string, options: SpotCapacityOptions): SpotCapacity {
    const asg = new SpotCapacity(this, id, {
      cluster: this.cluster,
      ...options,
    });

    this.cluster.addAutoScalingGroup(asg.autoScalingGroup);
    this.autoScalingGroups.push(asg.autoScalingGroup);
    return asg;
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

  public grantAdminAccess(identity: IIdentity) {
    identity.addManagedPolicy(this.adminManagedPolicy);
  }

  protected onPrepare(): void {
    super.onPrepare();

    this.servers.forEach((server) => {
      this.autoScalingGroups.forEach((asg) => {
        // Ensure all our capacity gets added _before_ we start adding tasks.
        server.service.node.addDependency(asg);

        // Ensure that each server is accessible from the internet.
        asg.connections.allowFromAnyIpv4(Port.udp(server.serverPort), "Allow Factorio Server");
        asg.connections.allowFromAnyIpv4(Port.tcp(server.rconPort), "Allow RCON");
      });
    });
  }
}

interface SpotCapacityProps extends SpotCapacityOptions {
  readonly cluster: Cluster;
}

export class SpotCapacity extends Construct {
  public readonly autoScalingGroup: AutoScalingGroup;
  private readonly minCapacity: number;
  private readonly maxCapacity: number;

  constructor(scope: Construct, id: string, props: SpotCapacityProps) {
    super(scope, id);

    this.minCapacity = props?.minCapacity || 0;
    this.maxCapacity = props?.maxCapacity || 1;

    this.autoScalingGroup = new AutoScalingGroup(this, "ASG", {
      vpc: props.cluster.vpc,
      machineImage: EcsOptimizedImage.amazonLinux2(),
      associatePublicIpAddress: true,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      instanceType: props.instanceType,
      minCapacity: this.minCapacity,
      maxCapacity: this.maxCapacity,
      desiredCapacity: this.maxCapacity,
      spotPrice: props.spotPrice,
      keyName: "temp_key_pair",
    });

    // Allows SSM access to instances in this ASG.
    //const instancePolicy = ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore');
    //this.autoScalingGroup.role.addManagedPolicy(instancePolicy);

    // TODO: We could filter this to just the EC2 Instance Connect IP Range for increased security (which would
    // limit SSH access to just the EC2 browser console).
    this.autoScalingGroup.connections.allowFromAnyIpv4(Port.tcp(22), "Allow SSH");

    Tags.of(this).add("fck:asg", this.node.uniqueId, {
      applyToLaunchedInstances: true,
    });
  }

  public addScheduledActions(enableSchedule: Schedule, disableSchedule: Schedule) {
    new ScheduledAction(this, "Enable", {
      autoScalingGroup: this.autoScalingGroup,
      schedule: enableSchedule,
      desiredCapacity: this.maxCapacity,
    });

    new ScheduledAction(this, "Disable", {
      autoScalingGroup: this.autoScalingGroup,
      schedule: disableSchedule,
      desiredCapacity: this.minCapacity,
    });
  }
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

    const volume: Volume = {
      name: "FactorioVolume",
      efsVolumeConfiguration: {
        fileSystemId: props.fileSystem.fileSystemId,
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
        logRetention: RetentionDays.FIVE_DAYS,
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

    props.fileSystem.connections.allowFrom(this.service, Port.tcp(2049), "Allow EFS");
  }
}
