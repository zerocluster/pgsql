import Events from "#core/events";
import Cron from "#lib/cron";
import fs from "fs";
import childProcess from "child_process";
import crypto from "crypto";
import sql from "#core/sql";

// https://www.postgresql.org/docs/current/server-shutdown.html

export default class Pgsql extends Events {
    #shutdownSignal;
    #proc;
    #cron;
    #isStarted;

    // properties
    get isStarted () {
        return this.#isStarted;
    }

    get cron () {
        return this.#cron;
    }

    // public
    async run ( env ) {
        if ( this.#isStarted ) return;

        this.#isStarted = true;

        const dataRoot = "/var/lib/docker/volumes/pgsql/_data",
            dataDir = dataRoot + "/" + process.env.POSTGRES_VERSION,
            unixSocketDirectories = "/var/run/postgresql";

        const uid = +childProcess.execFileSync( "id", ["-u", "postgres"], { "encoding": "utf8" } ).trim(),
            gid = +childProcess.execFileSync( "id", ["-g", "postgres"], { "encoding": "utf8" } ).trim();

        if ( fs.existsSync( dataRoot ) ) {
            fs.chownSync( dataRoot, uid, gid );
            fs.chmodSync( dataRoot, 0o700 );
        }

        if ( fs.existsSync( dataDir ) ) {
            fs.chownSync( dataDir, uid, gid );
            fs.chmodSync( dataDir, 0o700 );
        }

        // init db
        if ( !fs.existsSync( dataDir + "/PG_VERSION" ) ) {
            const pwfile = "/tmp/pgsql-password.txt";

            const superuserPassword = crypto.randomBytes( 16 ).toString( "base64url" );

            console.log( `GENERATED POSTGRES PASSWORD: ${superuserPassword}` );

            fs.writeFileSync( pwfile, superuserPassword );
            fs.chownSync( pwfile, uid, gid );

            childProcess.execFileSync( "initdb", ["--encoding", "UTF8", "--no-locale", "-U", "postgres", "--pwfile", pwfile, "-D", dataDir], { uid, gid } );

            fs.rmSync( pwfile, { "force": true } );
        }

        // generate pg_hba.conf
        const pgHba = [];
        if ( env?.["pg_hba.conf"] ) {
            for ( const access of env["pg_hba.conf"] ) {
                const line = [];

                for ( const name of ["host", "database", "user", "address", "auth-method", "auth-options"] ) {
                    if ( !access[name] ) continue;

                    line.push( access[name] );
                }

                pgHba.push( line.join( " " ) );
            }
        }
        fs.writeFileSync( dataDir + "/pg_hba.conf", pgHba.join( "\n" ) );
        fs.chownSync( dataDir + "/pg_hba.conf", uid, gid );

        // create "conf.d" dir
        if ( !fs.existsSync( dataDir + "/conf.d" ) ) {
            fs.mkdirSync( dataDir + "/conf.d", { "recursive": true } );
            fs.chownSync( dataDir + "/conf.d", uid, gid );

            // move "postgresql.conf"
            fs.copyFileSync( dataDir + "/postgresql.conf", dataDir + "/conf.d/0-postgresql.conf" );
            fs.chownSync( dataDir + "/conf.d/0-postgresql.conf", uid, gid );

            fs.writeFileSync( dataDir + "/postgresql.conf", "include_dir = 'conf.d'" );
            fs.chownSync( dataDir + "/postgresql.conf", uid, gid );
        }

        // generate default settings
        const settings = [];
        if ( env?.settings ) {
            if ( typeof env.settings === "string" ) {
                settings.push( env.settings );
            }
            else {
                for ( const name in env.settings ) {
                    const value = env.settings[name];

                    if ( typeof value === "string" ) settings.push( `${name} = '${value}'` );
                    else settings.push( `${name} = ${value}` );
                }
            }
        }
        fs.writeFileSync( dataDir + "/conf.d/1-init.conf", settings.join( "\n" ) );
        fs.chownSync( dataDir + "/conf.d/1-init.conf", uid, gid );

        // create and prepare unix socket dir
        if ( !fs.existsSync( unixSocketDirectories ) ) fs.mkdirSync( unixSocketDirectories, { "recursive": true } );
        fs.chownSync( unixSocketDirectories, uid, gid );

        // update extensions
        await this.#update( dataDir, unixSocketDirectories, uid, gid );

        // run server
        this.#proc = childProcess.spawn( "postgres", ["-D", dataDir, "-k", unixSocketDirectories, "-h", "0.0.0.0"], {
            uid,
            gid,
            "stdio": "inherit",
            "detached": true,
        } );

        // shutdown controller
        this.#shutdownSignal = global.shutdown.signal( "pgsql process" ).on( "shutdown", graceful => {
            if ( graceful ) {
                this.gracefulShutdown();
            }
            else {
                this.shutdown();
            }
        } );

        this.#proc.on( "exit", this.#onProcExit.bind( this ) );

        process.on( "SIGQUIT", this.immediateShutdown.bind( this ) );

        this.#cron = new Cron();
        await this.#cron.start();

        console.log( `PostgreSQL process started` );
    }

    shutdown () {
        this.fastShutdown();
    }

    gracefulShutdown () {
        this.fastShutdown();
    }

    smartShutdown () {
        if ( !this.#isStarted ) return;

        console.log( "PostgreSQL smart shutdown started" );

        this.#proc.kill( "SIGTERM" );
    }

    fastShutdown () {
        if ( !this.#isStarted ) return;

        console.log( "PostgreSQL fast shutdown started" );

        this.#proc.kill( "SIGINT" );
    }

    immediateShutdown () {
        if ( !this.#isStarted ) return;

        console.log( "PostgreSQL immediate shutdown started" );

        this.#proc.kill( "SIGQUIT" );
    }

    // private
    #onProcExit ( code, signal ) {
        this.#proc = null;
        this.#isStarted = false;

        console.log( `PostgreSQL process exited, code: ${code}` );

        process.exitCode = code;

        this.#shutdownSignal.done();

        this.emit( "exit", code );
    }

    async #update ( dataDir, unixSocketDirectories, uid, gid ) {
        const proc = childProcess.spawn( "postgres", ["-D", dataDir, "-k", unixSocketDirectories], {
            uid,
            gid,
            "stdio": "inherit",
            "detached": true,
        } );

        // wait for server is ready
        while ( 1 ) {
            const res = childProcess.spawnSync( "pg_isready", null, { "stdio": "inherit" } );

            if ( !res.status ) break;

            await new Promise( resolve => setTimeout( resolve, 1000 ) );
        }

        const dbh = await sql.new( "pgsql://postgres@unix/var/run/postgresql/.s.PGSQL.5432" );

        const res = await dbh.exec( sql`
CREATE EXTENSION IF NOT EXISTS softvisio_admin CASCADE;
ALTER EXTENSION softvisio_admin UPDATE;
CALL update_extensions();
` );

        console.log( `Updating extensions ... ${res}` );

        return new Promise( resolve => {
            proc.on( "exit", resolve );

            proc.kill( "SIGINT" );
        } );
    }
}
