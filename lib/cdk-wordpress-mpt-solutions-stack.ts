import * as cdk from '@aws-cdk/core';
import * as certificatemanager from '@aws-cdk/aws-certificatemanager';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as ecs from '@aws-cdk/aws-ecs';
import * as ecs_patterns from '@aws-cdk/aws-ecs-patterns';
import * as efs from '@aws-cdk/aws-efs';
import * as logs from '@aws-cdk/aws-logs';
import * as rds from '@aws-cdk/aws-rds';
import * as route53 from '@aws-cdk/aws-route53';
import * as secretsmanager from '@aws-cdk/aws-secretsmanager';
import * as s3 from '@aws-cdk/aws-s3';
import * as iam from '@aws-cdk/aws-iam';

export class CdkWordpressMptSolutionsStack extends cdk.Stack {

  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const domainZone = route53.HostedZone.fromLookup(this, 'DomainZone', {
      domainName: 'mpt.solutions',
      privateZone: false,
    });

    const certificate = new certificatemanager.Certificate(this, 'Cert', {
      domainName: domainZone.zoneName,
      subjectAlternativeNames: [`*.${domainZone.zoneName}`],
      validation: certificatemanager.CertificateValidation.fromDns()
    });

    const logging = ecs.LogDriver.awsLogs({
      logGroup: new logs.LogGroup(this, 'CdkLogGroup', {
        logGroupName: 'mpt.solutions',
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        retention: logs.RetentionDays.ONE_WEEK
      }),
      streamPrefix: 'cdk'
    })

    const vpc = new ec2.Vpc(this, 'ClusterVpc', {
      cidr: '10.0.0.0/16',
      natGateways: 0,
      maxAzs: 2,
      subnetConfiguration: [
        {
          cidrMask: 18,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        }
      ]
    });

    const cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: 'mpt-solutions-cdk',
      containerInsights: true,
      vpc
    });

    const vpcSg = new ec2.SecurityGroup(this, 'VpcSecurityGroup', {
      vpc,
      allowAllOutbound: false,
      securityGroupName: 'core',
    });

    vpcSg.addIngressRule(ec2.Peer.ipv4(cluster.vpc.vpcCidrBlock), ec2.Port.allTraffic());
    vpcSg.addEgressRule(ec2.Peer.ipv4(cluster.vpc.vpcCidrBlock), ec2.Port.allTraffic());

    const dbUser = "wpdbadmin";
    const dbName = "wordpress";

    const dbSecret = new secretsmanager.Secret(this, 'dbCredentialsSecret', {
      secretName: "aurora-mysql",
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: dbUser,
        }),
        excludePunctuation: true,
        includeSpace: false,
        generateStringKey: 'password'
      }
    });

    const aurora = new rds.ServerlessCluster(this, 'AuroraServerless', {
      engine: rds.DatabaseClusterEngine.AURORA_MYSQL,
      vpc,
      enableDataApi: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      credentials: rds.Credentials.fromSecret(dbSecret, dbUser),
      scaling: {
        autoPause: cdk.Duration.minutes(10), // default is to pause after 5 minutes of idle time
        minCapacity: rds.AuroraCapacityUnit.ACU_8, // default is 2 Aurora capacity units (ACUs)
        maxCapacity: rds.AuroraCapacityUnit.ACU_32, // default is 16 Aurora capacity units (ACUs)
      },
      defaultDatabaseName: dbName,
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    }).connections.allowFromAnyIpv4(ec2.Port.tcp(3306));

    const logGroup = new logs.LogGroup(this, 'LogGroup');

    const task = new ecs.FargateTaskDefinition(this, 'Task', {
      cpu: 256,
      memoryLimitMiB: 512,
      executionRole: this._createTaskExecutionRole(),
      taskRole: this._createTaskRole()
    });

    task.addContainer('wordpress', {
      containerName: 'wordpress',
      image: ecs.ContainerImage.fromRegistry('wordpress'),
      secrets: {
        WORDPRESS_DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
        WORDPRESS_DB_HOST: ecs.Secret.fromSecretsManager(dbSecret, 'host'),
        WORDPRESS_DB_USER: ecs.Secret.fromSecretsManager(dbSecret, 'username'),
      },
      environment: {
        WORDPRESS_DB_NAME: dbName
      },
      portMappings: [{ containerPort: 80 }],
    });

    logGroup.grantWrite(task.taskRole);

    const wpService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, 'WPService', {
      cluster,
      taskDefinition: task,
      certificate,
      assignPublicIp: true,
      domainName: `www.${domainZone.zoneName}`,
      domainZone,
      platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
      redirectHTTP: true,
      healthCheckGracePeriod: cdk.Duration.seconds(180),
    });

    wpService.targetGroup.configureHealthCheck({
      path: '/index.php',
      healthyHttpCodes: '200,302'
    });

    const wpScaling = wpService.service.autoScaleTaskCount({ maxCapacity: 2, minCapacity: 1 })
    wpScaling.scaleOnMemoryUtilization('WpScaleByMemory', { targetUtilizationPercent: 75 })
    wpScaling.scaleOnCpuUtilization('WpScaleByCpu', { targetUtilizationPercent: 75 })

    const wpEfsVolume = new efs.FileSystem(this, 'WPVolume', {
      vpc: cluster.vpc,
      fileSystemName: 'wordpress-volume',
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      securityGroup: vpcSg,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    })

    wpService.taskDefinition.addVolume({
      efsVolumeConfiguration: {
        fileSystemId: wpEfsVolume.fileSystemId,
        transitEncryption: "ENABLED",
      },
      name: "efs"
    });

    wpService.taskDefinition.defaultContainer?.addMountPoints({
      containerPath: '/var/www/html',
      sourceVolume: 'efs',
      readOnly: false
    });

    // ecs exec bucket
    const execBucket = new s3.Bucket(this, 'EcsExecBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const cfnCluster = cluster.node.defaultChild as ecs.CfnCluster;
    cfnCluster.addPropertyOverride('Configuration.ExecuteCommandConfiguration', {
      LogConfiguration: {
        CloudWatchLogGroupName: logGroup.logGroupName,
        S3BucketName: execBucket.bucketName,
        S3KeyPrefix: 'exec-output',
      },
      Logging: 'OVERRIDE',
    });

    // enable EnableExecuteCommand for the service
    const cfnService = wpService.service.node.findChild('Service') as ecs.CfnService;
    cfnService.addPropertyOverride('EnableExecuteCommand', true);

    new cdk.CfnOutput(this, 'EcsExecCommand', {
      value:
        `ecs_exec_service ${cluster.clusterName} ${wpService.service.serviceName}`,
    });

  }
  private _createTaskExecutionRole(): iam.Role {
    const role = new iam.Role(this, 'TaskExecRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'));
    return role;
  }
  private _createTaskRole(): iam.Role {
    const role = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'ssmmessages:CreateControlChannel',
        'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel',
        'ssmmessages:OpenDataChannel',
      ],
      resources: ['*'],
    }));

    return role;
  }
}
